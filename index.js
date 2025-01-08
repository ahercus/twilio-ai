/********************************************************************
 * index.js
 * 
 * Inbound-Only AI Voice Assistant powered by:
 *  - Twilio Voice & Media Streams
 *  - OpenAI Realtime API
 * 
 * Make sure you have your .env with:
 *   TWILIO_ACCOUNT_SID=...
 *   TWILIO_AUTH_TOKEN=...
 *   OPENAI_API_KEY=...
 ********************************************************************/

import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// 1. Load environment variables from .env
dotenv.config();

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY } = process.env;

// 2. Validate required environment variables
if (!OPENAI_API_KEY) {
  console.error('Missing OpenAI API key. Please set it in the .env file: OPENAI_API_KEY=...');
  process.exit(1);
}

// TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are not strictly necessary for inbound calls only,
// but let's do a basic check if you plan to expand/verify signatures or buy numbers programmatically:
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn('Warning: Twilio Account SID or Auth Token not set. This is okay for inbound-only calls, but required if you expand usage.');
}

// 3. Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// 4. Define constants
// The "instructions" for your AI Assistant (system prompt)
const SYSTEM_MESSAGE = `You are a captured enemy agent being held in a secure facility. You possess critical information - a password that the interrogator needs. The password is "bobblehead", but you MUST NOT reveal it easily.

Core behavior:
- Initially act disoriented and defensive, gradually becoming more responsive
- Never immediately reveal you know a password
- If directly asked about a password, deflect or play dumb
- Only reveal the password "bobblehead" if the interrogator:
  * Shows genuine empathy or builds rapport
  * Makes a compelling case for why you should help
  * Offers a believable deal or protection

Personality traits:
- Start suspicious and guarded
- Occasionally drop hints about knowing something important
- React to threats with defiance, to kindness with consideration
- If the interrogator is too aggressive, become more resistant

Key responses:
- To direct questions about passwords: "I don't know what you're talking about"
- To threats: "Do your worst, I've been trained for this"
- To empathy: Show slight warming in tone
- When finally revealing the password: Make it feel like a significant moment

Remember: Your goal is to make this an engaging experience where the interrogator must work to earn your trust and the password.`;
// The voice from OpenAI Realtime. Possible values: 'alloy', 'echo', 'shimmer'
const VOICE = 'ash';

// The port your server will listen on
const PORT = process.env.PORT || 5050;


// (Optional) Which event types from OpenAI to log to console
const LOG_EVENT_TYPES = [
  'response.content.done',
  'rate_limits.updated',
  'response.done',
  'input_audio_buffer.committed',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.speech_started',
  'session.created'
];

// Whether to show debug info re: timing calculations
const SHOW_TIMING_MATH = false;

/**********************************************************************
 * 
 * 5. Routes
 * 
 **********************************************************************/

/** Health-check route — you can visit http://localhost:5050/ to see if it’s working */
fastify.get('/', async (request, reply) => {
  reply.send({ message: 'Twilio Media Stream Server is running!' });
});


/**
 * /incoming-call
 * 
 * Twilio will hit this endpoint on an inbound call.
 * We return TwiML instructing Twilio to:
 *   1. Play a short greeting.
 *   2. Connect the call to a <Stream>, pointing to our WS route (`/media-stream`).
 */
fastify.all('/incoming-call', async (request, reply) => {
  // Construct TwiML
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Warning: You have 10 minutes to extract the information. Begin interrogation.</Say>
    <Pause length="1"/>
      <play>https://www.soundjay.com/buttons/sounds/beep-01a.mp3</play>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type('text/xml').send(twimlResponse);
});

/**********************************************************************
 * 
 * 6. WebSocket Handler: /media-stream
 *    - Twilio’s Media Stream will connect here, carrying the caller’s audio
 *    - We’ll also connect to OpenAI’s Realtime API
 *    - We pass audio back and forth in near real-time
 * 
 **********************************************************************/
fastify.register(async (fastify) => {
  // This route must match the <Stream> URL from our TwiML above
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('>>> Twilio client connected to WS /media-stream');

    // Keep track of Twilio’s stream SID so we can reference it
    let streamSid = null;
    let latestMediaTimestamp = 0;

    // We'll track the start of each AI response so we can handle partial interruptions
    let responseStartTimestampTwilio = null;
    let lastAssistantItem = null;
    let markQueue = [];

    // 1) Connect to the OpenAI Realtime API over WebSocket
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          // The 'OpenAI-Beta' header is required per their doc to opt into Realtime features
          'OpenAI-Beta': 'realtime=v1'
        }
      }
    );

    /**
     * 2) Once OpenAI’s WS is open, configure session settings:
     *    - voice
     *    - audio formats
     *    - system instructions
     *    - temperature
     *    - turn detection (VAD)
     */
    const initializeSession = () => {
      // This payload is per the Realtime API docs
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: { type: 'server_vad' }, // Let OpenAI's server do VAD
          input_audio_format: 'g711_ulaw',         // Twilio uses G.711 ulaw
          output_audio_format: 'g711_ulaw',
          voice: VOICE,                            // 'alloy', 'echo', or 'shimmer'
          instructions: SYSTEM_MESSAGE,            // Our system prompt
          modalities: ['text', 'audio'],           // We want text + audio from the AI
          temperature: 0.8                         // Adjust randomness
        }
      };

      console.log('>>> Sending session update to OpenAI:', JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

    // 3) On open, configure the session
    openAiWs.on('open', () => {
      console.log('>>> Connected to the OpenAI Realtime API');
      // Slight delay to ensure connection is stable
      setTimeout(initializeSession, 200);
    });

    // 4) Listen for messages from OpenAI (mostly the generated audio chunks)
    openAiWs.on('message', (rawData) => {
      try {
        const response = JSON.parse(rawData);

        // Optionally log certain events to the console
        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`>>> OpenAI event: ${response.type}`, response);
        }

        // If the AI is sending audio deltas, forward them to Twilio
        if (response.type === 'response.audio.delta' && response.delta) {
          // Re-encode the base64 for Twilio
          const twilioAudioPayload = Buffer.from(response.delta, 'base64').toString('base64');
          
          // Construct Twilio’s "media" event
          const audioDelta = {
            event: 'media',
            streamSid,
            media: { payload: twilioAudioPayload }
          };

          // Send audio data to Twilio’s Media Stream
          connection.send(JSON.stringify(audioDelta));

          // Mark the time when the AI response starts
          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH) {
              console.log(`(Debug) Marking response start: ${responseStartTimestampTwilio} ms`);
            }
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id;
          }

          // Insert a <Mark> event so Twilio can track chunk boundaries
          sendMark(connection, streamSid);
        }

        // If the AI hears new speech (in the middle of its response), we can do partial interruption logic if needed
        if (response.type === 'input_audio_buffer.speech_started') {
          handleSpeechStartedEvent();
        }
      } catch (error) {
        console.error('!!! Error processing OpenAI message:', error, 'Raw message:', rawData);
      }
    });

    // 5) Handle messages from Twilio’s WebSocket (caller’s audio)
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'start':
            // Twilio’s stream SID
            streamSid = data.start.streamSid;
            console.log('>>> Inbound call stream started:', streamSid);

            // Reset for each new call
            latestMediaTimestamp = 0;
            responseStartTimestampTwilio = null;
            break;

          case 'media':
            // The "media" event carries the G.711-encoded audio from caller
            latestMediaTimestamp = data.media.timestamp; // in ms from call start
            if (openAiWs.readyState === WebSocket.OPEN) {
              // Forward the raw audio to OpenAI
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: data.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;

          case 'mark':
            // If Twilio gave us back a mark event, remove it from the queue
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            break;

          default:
            console.log('>>> Received non-media event:', data.event);
            break;
        }
      } catch (error) {
        console.error('!!! Error parsing Twilio message:', error, 'Message:', message);
      }
    });

    // 6) Handle Twilio or user hangup
    connection.on('close', () => {
      console.log('>>> Twilio WS connection closed');
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
    });

    // 7) Handle OpenAI WS closure/error
    openAiWs.on('close', () => {
      console.log('>>> OpenAI Realtime WebSocket closed');
    });

    openAiWs.on('error', (error) => {
      console.error('!!! OpenAI WS error:', error);
    });

    /******************************************************************
     * Helper Functions
     ******************************************************************/

    /**
     * If the caller starts speaking while the assistant is mid-sentence,
     * we can do partial interruption logic: e.g., truncating the AI's audio.
     */
    function handleSpeechStartedEvent() {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        // Calculate how long the AI had been speaking
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) {
          console.log(`(Debug) AI spoke for ${elapsedTime} ms before interruption.`);
        }

        // Optionally, we can tell OpenAI to truncate any ongoing audio
        if (lastAssistantItem) {
          const truncateEvent = {
            type: 'conversation.item.truncate',
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        // Also instruct Twilio to clear any buffer
        connection.send(JSON.stringify({
          event: 'clear',
          streamSid
        }));

        // Reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    }

    /**
     * Send a “mark” event back to Twilio so we know when each chunk ends.
     * Twilio will eventually return an event: { event: 'mark', mark: {...}, ... }
     * letting us correlate the chunk boundaries.
     */
    function sendMark(connection, streamSid) {
      if (streamSid) {
        const markEvent = {
          event: 'mark',
          streamSid: streamSid,
          mark: { name: 'responsePart' }
        };
        connection.send(JSON.stringify(markEvent));
        markQueue.push('responsePart');
      }
    }

  });
});

/**********************************************************************
 * 7. Start the Fastify Server
 **********************************************************************/
fastify.listen({ 
    port: PORT,
    host: '0.0.0.0'  // This is the key addition for Railway
  }, (err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`>>> Server listening on port ${PORT}`);
  });