import "dotenv-flow/config";
import express from "express";
import ExpressWs from "express-ws";
import * as crypto from "crypto";
import twilio from "twilio";
import bot from "./bot";
import { TwilioMediaStreamWebsocket, StartEvent } from "./twilio";

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

// ========================================
// Configuration
// ========================================
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const API_URL = process.env.API_URL || "wss://api.x.ai/v1/realtime";
// Twilio auth token, used to verify that webhook requests really come from Twilio
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
// Feature flags
const ENABLE_TOOLS = process.env.ENABLE_TOOLS !== "false"; // Default: enabled

// Public hostname Twilio uses to reach this server (no protocol, no trailing slash)
function publicHostname(): string {
  return (process.env.HOSTNAME || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

// ========================================
// Twilio Webhook Signature Validation
// ========================================
// Twilio signs every webhook request (X-Twilio-Signature: HMAC-SHA1 over the full
// public URL plus the POST parameters, keyed with the account auth token). Only
// requests carrying a valid signature reach the TwiML handlers, so an arbitrary party
// that discovers the public HOSTNAME cannot obtain TwiML or media-stream call tokens.
function verifyTwilioSignature(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!TWILIO_AUTH_TOKEN) {
    console.error("Rejecting Twilio webhook: TWILIO_AUTH_TOKEN is not set");
    res.status(503).send("Server misconfigured: TWILIO_AUTH_TOKEN not set");
    return;
  }
  const hostname = publicHostname();
  if (!hostname) {
    res.status(500).send("Server misconfigured: HOSTNAME not set");
    return;
  }
  const signature = req.header("X-Twilio-Signature") || "";
  const url = `https://${hostname}${req.originalUrl}`;
  const params = req.body && typeof req.body === "object" ? req.body : {};
  if (!signature || !twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, params)) {
    console.warn(`Rejected webhook request for ${req.path}: missing or invalid X-Twilio-Signature`);
    res.status(403).send("Forbidden: invalid Twilio signature");
    return;
  }
  next();
}

// ========================================
// Per-Call Media Stream Tokens
// ========================================
// The signature-validated TwiML endpoints issue a random one-time token that Twilio
// hands back in the media stream's `start` message (<Parameter name="token" />).
// The media-stream WebSocket handlers refuse to open an xAI session until they have
// received a valid, unexpired token, so an unauthenticated WebSocket client cannot
// drive realtime sessions billed to this server's XAI_API_KEY.
const CALL_TOKEN_TTL_MS = 5 * 60 * 1000;
const pendingCallTokens = new Map<string, number>();

function issueCallToken(): string {
  const now = Date.now();
  for (const [token, issuedAt] of pendingCallTokens) {
    if (now - issuedAt > CALL_TOKEN_TTL_MS) {
      pendingCallTokens.delete(token);
    }
  }
  const token = crypto.randomBytes(16).toString("hex");
  pendingCallTokens.set(token, now);
  return token;
}

function consumeCallToken(token: unknown): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  const issuedAt = pendingCallTokens.get(token);
  if (issuedAt === undefined) {
    return false;
  }
  pendingCallTokens.delete(token);
  return Date.now() - issuedAt <= CALL_TOKEN_TTL_MS;
}

// Wait for Twilio's `start` message (which carries the custom parameters) on a
// freshly connected media stream.
function waitForStart(tw: TwilioMediaStreamWebsocket, timeoutMs = 10000): Promise<StartEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Twilio start event")), timeoutMs);
    tw.on("start", (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    tw.ws.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Twilio stream closed before start event"));
    });
  });
}

// Clean event logging - just event names, no emojis
function logEvent(callId: string, eventType: string, extra?: string) {
  if (extra) {
    console.log(`[${callId}] ${eventType}`);
    console.log(`  ${extra}`);
  } else {
    console.log(`[${callId}] ${eventType}`);
  }
}

// Helper to generate cryptographically secure IDs
function generateSecureId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

// ========================================
// Tool Definitions
// ========================================
const tools = [
  {
    type: "function",
    name: "generate_random_number",
    description: "Generate a random number between min and max values",
    parameters: {
      type: "object",
      properties: {
        min: {
          type: "number",
          description: "Minimum value (inclusive)",
        },
        max: {
          type: "number",
          description: "Maximum value (inclusive)",
        },
      },
      required: ["min", "max"],
    },
  },
];

// ========================================
// Tool Handlers
// ========================================
async function handleToolCall(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "generate_random_number": {
      const min = Math.ceil(args.min);
      const max = Math.floor(args.max);
      const result = Math.floor(Math.random() * (max - min + 1)) + min;
      return JSON.stringify({ result, min: args.min, max: args.max });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ========================================
// Health Check Endpoint
// ========================================
app.get("/health", (req, res) => {
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
  };
  res.json(health);
});

// ========================================
// Twilio Voice Webhook Endpoints
// ========================================
app.post("/twiml", verifyTwilioSignature, async (req, res) => {
  try {
    const callId = generateSecureId('call');

    if (!process.env.HOSTNAME) {
      res.status(500).send("Server misconfigured: HOSTNAME not set");
      return;
    }

    res.status(200);
    res.type("text/xml");

    const hostname = publicHostname();
    const streamUrl = `wss://${hostname}/media-stream/${callId}`;
    const token = issueCallToken();

    const twimlResponse = `\
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="token" value="${token}" />
    </Stream>
  </Connect>
</Response>
`;
    res.end(twimlResponse);
  } catch (error) {
    res.status(500).send();
  }
});

app.post("/call-status", verifyTwilioSignature, async (req, res) => {
  res.status(200).send();
});

// ========================================
// Twilio Media Stream Websocket Endpoint
// ========================================
app.ws("/media-stream/:callId", async (ws, req) => {
  const callId = req.params.callId;

  if (typeof callId !== "string" || !/^call_[0-9a-f]{32}$/.test(callId)) {
    ws.close(1008, "Invalid call id");
    return;
  }

  const tw = new TwilioMediaStreamWebsocket(ws);

  // Do not contact x.ai until Twilio has proven that this stream belongs to a call
  // that /twiml issued (see issueCallToken).
  let startMsg: StartEvent;
  try {
    startMsg = await waitForStart(tw);
  } catch (error: any) {
    logEvent(callId, 'twilio.start.timeout', error?.message || String(error));
    ws.close(1008, "Twilio start event not received");
    return;
  }

  if (!consumeCallToken(startMsg.start.customParameters?.token)) {
    logEvent(callId, 'twilio.start.rejected', 'missing or invalid call token');
    ws.close(1008, "Unauthorized media stream");
    return;
  }

  tw.streamSid = startMsg.start.streamSid;
  logEvent(callId, 'twilio.start');
  console.log(`\n[${callId}] === CALL STARTED ===`);

  // Create raw WebSocket connection to x.ai
  const WebSocket = require('ws');
  const xaiWs = new WebSocket(API_URL, {
    headers: {
      'Authorization': `Bearer ${XAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  // Wait for x.ai WebSocket to be ready. A failed handshake must not escape as an
  // unhandled rejection (which would take down the whole server and every live call).
  try {
    await new Promise((resolve, reject) => {
      const wsTimeout = setTimeout(() => {
        reject(new Error("x.ai WebSocket connection timeout"));
      }, 10000);

      xaiWs.on('open', () => {
        clearTimeout(wsTimeout);
        logEvent(callId, 'websocket.open');
        resolve(null);
      });

      xaiWs.on('error', (error: any) => {
        clearTimeout(wsTimeout);
        reject(error);
      });
    });
  } catch (error: any) {
    logEvent(callId, 'websocket.error', error?.message || String(error));
    try {
      xaiWs.close();
    } catch {
      // Socket already closed
    }
    ws.close(1011, "Upstream connection failed");
    return;
  }

  // Flag to track when session is configured - DO NOT send audio until this is true
  let sessionReady = false;
  let turnCount = 0;
  let turnActive = false; // Track if a turn is in progress

  // Handle messages from x.ai WebSocket
  xaiWs.on('message', (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());

      // Log events to console (skip raw audio chunks)
      if (message.type !== 'response.output_audio.delta' && message.type !== 'input_audio_buffer.append') {
        logEvent(callId, message.type);
      }

      if (message.type === 'response.output_audio.delta' && message.delta) {
        // Bot is speaking - sending audio to Twilio (PCMU format)
        const twilioMessage = {
          event: "media" as const,
          media: { payload: message.delta },
          streamSid: tw.streamSid!,
        };
        tw.send(twilioMessage);
      } else if (message.type === 'response.created') {
        // Check if previous turn was interrupted (new response started before previous ended)
        if (turnActive) {
          console.log(`[${callId}] === TURN ${turnCount} INTERRUPTED ===\n`);
        }
        // Mark turn start
        turnCount++;
        turnActive = true;
        console.log(`\n[${callId}] === START TURN ${turnCount} ===`);
      } else if (message.type === 'response.done') {
        // Mark turn end
        turnActive = false;
        console.log(`[${callId}] === END TURN ${turnCount} ===\n`);
      } else if (message.type === 'response.cancelled') {
        // Turn was explicitly cancelled
        turnActive = false;
        console.log(`[${callId}] === TURN ${turnCount} CANCELLED ===\n`);
      } else if (message.type === 'response.output_audio_transcript.delta') {
        // Log bot's speech transcript
        console.log(`[${callId}] Bot: "${message.delta}"`);
      } else if (message.type === 'session.updated') {
        // Session is now configured with correct audio format - safe to send audio
        sessionReady = true;

        // Now that session is configured, send initial greeting
        const conversationItem = {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Say hello and introduce yourself'
              }
            ]
          }
        };
        logEvent(callId, conversationItem.type);
        xaiWs.send(JSON.stringify(conversationItem));

        const responseCreate = { type: 'response.create' };
        logEvent(callId, responseCreate.type);
        xaiWs.send(JSON.stringify(responseCreate));
      } else if (message.type === 'conversation.created') {
        console.log(`  conversation_id: ${message.conversation?.id || 'unknown'}`);

        // Send session configuration
        const sessionConfig = {
          type: 'session.update',
          session: {
            instructions: bot.instructions,
            voice: 'ara',
            audio: {
              input: { format: { type: 'audio/pcmu' } },
              output: { format: { type: 'audio/pcmu' } },
            },
            turn_detection: { type: 'server_vad' },
            ...(ENABLE_TOOLS ? { tools: tools } : {}),
          }
        };
        logEvent(callId, sessionConfig.type);
        xaiWs.send(JSON.stringify(sessionConfig));

      } else if (message.type === 'input_audio_buffer.speech_started') {
        // Clear Twilio's audio buffer (interrupt bot if speaking)
        const clearEvent = { event: "clear" as const, streamSid: tw.streamSid! };
        tw.send(clearEvent);

      } else if (message.type === 'error') {
        console.log(`  ERROR: ${message.error?.message || JSON.stringify(message)}`);
      } else if (message.type === 'conversation.item.added') {
        // Silently handle - conversation item added (same as created)
      } else if (message.type === 'response.output_item.added') {
        // Silently handle - output item added to response
      } else if (message.type === 'response.output_item.done') {
        // Check if this is a function call
        if (message.item?.type === 'function_call') {
          // Handle function call asynchronously
          (async () => {
            const functionName = message.item.name;
            const callId_fn = message.item.call_id;
            let args: Record<string, any> = {};
            
            try {
              args = JSON.parse(message.item.arguments || '{}');
            } catch (e) {
              // Failed to parse function arguments
            }
            
            console.log(`[${callId}] FUNCTION CALL: ${functionName}(${JSON.stringify(args)})`);
            
            // Execute the tool
            const result = await handleToolCall(functionName, args);
            console.log(`[${callId}] FUNCTION RESULT: ${result}`);
            
            // Send the function result back to XAI
            const functionResult = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: callId_fn,
                output: result,
              }
            };
            logEvent(callId, functionResult.type);
            xaiWs.send(JSON.stringify(functionResult));
            
            // Trigger a new response to continue the conversation
            const responseCreate = { type: 'response.create' };
            logEvent(callId, responseCreate.type);
            xaiWs.send(JSON.stringify(responseCreate));
          })();
        }
      } else if (message.type === 'conversation.item.input_audio_transcription.completed') {
        // Log user speech transcription
        if (message.transcript) {
          console.log(`[${callId}] User: "${message.transcript}"`);
        }
      }
      // All other events are just logged by their type (already done above)
    } catch (error) {
      console.error(`[${callId}] Error processing message from x.ai:`, error);
    }
  });

  // Send human speech to x.ai
  tw.on("media", (msg) => {
    try {
      if (msg.media.track === 'inbound') {
        const mulawBase64 = msg.media.payload;

        // DO NOT send audio until session is configured with correct format
        if (!sessionReady) {
          return;
        }

        // Send μ-law audio directly to XAI
        const audioMessage = {
          type: "input_audio_buffer.append",
          audio: mulawBase64
        };

        // Check WebSocket state before sending
        if (xaiWs.readyState !== 1) {
          return;
        }

        xaiWs.send(JSON.stringify(audioMessage));
      }
    } catch (error) {
      console.error(`[${callId}] Error processing audio from Twilio:`, error);
    }
  });

  // Handle x.ai WebSocket errors
  xaiWs.on('error', (error: any) => {
    logEvent(callId, 'websocket.error', error?.message || String(error));
  });

  xaiWs.on('close', (code: number, reason: Buffer) => {
    logEvent(callId, 'websocket.close', `code=${code}`);
  });

  // Handle Twilio WebSocket close
  ws.on("close", () => {
    logEvent(callId, 'twilio.close');
    xaiWs.close();
  });
});

/****************************************************
 Outbound Call Endpoints
****************************************************/

// Outbound agent instructions - this agent makes calls to end users
const OUTBOUND_AGENT_INSTRUCTIONS = `You are an outbound voice agent powered by the Grok Voice Agent API from xAI. You are calling a user to tell them about this exciting new technology.

IMPORTANT: You are making an OUTBOUND call, so YOU must speak first to initiate the conversation.

Start by greeting the user warmly and introducing yourself. Then explain:
- You're calling to share information about the Grok Voice Agent API
- This is a real-time voice AI API that enables natural conversations
- It supports telephony integration with Twilio, WebRTC for browsers, and WebSocket connections
- The API features ultra-low latency, natural turn-taking, and high-quality voice synthesis
- Developers can build voice assistants, customer service agents, and interactive voice applications

Be enthusiastic but not pushy. Answer any questions they have about the technology. Keep responses concise since this is a phone call.

If they're not interested, politely thank them for their time and end the call gracefully.`;

// TwiML endpoint for outbound calls
app.post("/outbound-twiml", verifyTwilioSignature, (req, res) => {
  const hostname = publicHostname();
  const token = issueCallToken();

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${hostname}/outbound-stream">
      <Parameter name="token" value="${token}" />
    </Stream>
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

// WebSocket endpoint for outbound call audio
app.ws("/outbound-stream", (ws: any, req: any) => {
  const WebSocket = require('ws');
  const MAX_TURNS = 3;
  let callSid = "";
  let streamSid = "";
  let xaiWs: any = null;
  let sessionReady = false;
  let turnCount = 0;
  let turnActive = false;

  // Drop streams that never present a valid start event (see issueCallToken)
  const startTimeout = setTimeout(() => {
    if (!streamSid) {
      console.log(`[OUTBOUND] Closing media stream: no start event received`);
      ws.close(1008, "Twilio start event not received");
    }
  }, 10000);

  // Handle Twilio WebSocket messages
  ws.on("message", async (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === "start") {
        if (!consumeCallToken(msg.start?.customParameters?.token)) {
          console.log(`[OUTBOUND] Rejected media stream: missing or invalid call token`);
          ws.close(1008, "Unauthorized media stream");
          return;
        }
        clearTimeout(startTimeout);
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        console.log(`\n[OUTBOUND] === OUTBOUND CALL STARTED ===`);
        console.log(`[OUTBOUND] [${callSid}] twilio.start`);

        // Connect to XAI
        xaiWs = new WebSocket(API_URL, {
          headers: {
            Authorization: `Bearer ${XAI_API_KEY}`,
          },
        });

        xaiWs.on("error", (error: any) => {
          console.log(`[OUTBOUND] [${callSid}] websocket.error ${error?.message || String(error)}`);
        });

        xaiWs.on("open", () => {
          console.log(`[OUTBOUND] [${callSid}] websocket.open`);

          // Send session configuration
          const sessionConfig = {
            type: "session.update",
            session: {
              instructions: OUTBOUND_AGENT_INSTRUCTIONS,
              voice: "rex",
              audio: {
                input: { format: { type: "audio/pcmu" } },
                output: { format: { type: "audio/pcmu" } },
              },
              turn_detection: { type: "server_vad" },
            },
          };
          console.log(`[OUTBOUND] [${callSid}] session.update`);
          xaiWs.send(JSON.stringify(sessionConfig));
        });

        xaiWs.on("message", (xaiData: Buffer) => {
          try {
            const message = JSON.parse(xaiData.toString());

            // Log event type (skip audio chunks)
            if (message.type !== "response.output_audio.delta") {
              console.log(`[OUTBOUND] [${callSid}] ${message.type}`);
            }

            if (message.type === "session.updated") {
              sessionReady = true;
              
              // Trigger the agent to speak first (outbound call)
              const responseCreate = { type: "response.create" };
              xaiWs.send(JSON.stringify(responseCreate));
              console.log(`[OUTBOUND] [${callSid}] Agent speaking first...`);
            } else if (message.type === "response.created") {
              if (turnActive) {
                console.log(`[OUTBOUND] [${callSid}] === TURN ${turnCount} INTERRUPTED ===\n`);
              }
              turnCount++;
              turnActive = true;
              console.log(`\n[OUTBOUND] [${callSid}] === START TURN ${turnCount} ===`);
            } else if (message.type === "response.output_audio.delta" && message.delta) {
              // Send bot audio to Twilio
              const twilioMessage = {
                event: "media",
                streamSid,
                media: { payload: message.delta },
              };
              ws.send(JSON.stringify(twilioMessage));
            } else if (message.type === "response.output_audio_transcript.delta") {
              if (message.delta) {
                console.log(`[OUTBOUND] [${callSid}] Caller: "${message.delta}"`);
              }
            } else if (message.type === "conversation.item.input_audio_transcription.completed") {
              if (message.transcript) {
                console.log(`[OUTBOUND] [${callSid}] Remote: "${message.transcript}"`);
              }
            } else if (message.type === "response.done") {
              turnActive = false;
              console.log(`[OUTBOUND] [${callSid}] === END TURN ${turnCount} ===\n`);
              
              // End call after MAX_TURNS
              if (turnCount >= MAX_TURNS) {
                console.log(`[OUTBOUND] [${callSid}] Max turns reached, ending in 10s...`);
                setTimeout(() => {
                  console.log(`[OUTBOUND] [${callSid}] Ending call now`);
                  if (xaiWs) xaiWs.close();
                  ws.close();
                }, 10000);
              }
            } else if (message.type === "error") {
              console.log(`[OUTBOUND] [${callSid}] ERROR: ${message.error?.message || JSON.stringify(message)}`);
            }
          } catch (e) {
            // Ignore parse errors
          }
        });

        xaiWs.on("close", () => {
          console.log(`[OUTBOUND] [${callSid}] websocket.close`);
        });

      } else if (msg.event === "media" && msg.media?.track === "inbound") {
        // Forward audio from the remote party to XAI
        if (xaiWs && sessionReady && xaiWs.readyState === WebSocket.OPEN) {
          const audioMessage = {
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          };
          xaiWs.send(JSON.stringify(audioMessage));
        }
      } else if (msg.event === "stop") {
        console.log(`[OUTBOUND] [${callSid}] twilio.stop`);
        if (xaiWs) xaiWs.close();
      }
    } catch (e) {
      // Ignore errors
    }
  });

  ws.on("close", () => {
    clearTimeout(startTimeout);
    console.log(`[OUTBOUND] twilio.close`);
    if (xaiWs) xaiWs.close();
  });
});

/****************************************************
 Start Server
****************************************************/
const port = process.env.PORT || "3000";
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Tool calling: ${ENABLE_TOOLS ? "ENABLED" : "DISABLED"}`);
  if (!XAI_API_KEY) {
    console.warn("WARNING: XAI_API_KEY is not set - realtime sessions will fail");
  }
  if (!TWILIO_AUTH_TOKEN) {
    console.warn("WARNING: TWILIO_AUTH_TOKEN is not set - Twilio webhooks will be rejected");
  }
  if (!publicHostname()) {
    console.warn("WARNING: HOSTNAME is not set - Twilio webhooks will be rejected");
  }
});
