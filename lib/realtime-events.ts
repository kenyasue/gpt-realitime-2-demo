import type { VoiceId } from "./personas";

/**
 * Shape of the GA Realtime session config. Mostly used as a guide — the API
 * accepts a deep-partial of this object inside `session.update` events.
 */
export interface SessionConfig {
  type?: "realtime";
  model?: string;
  instructions?: string;
  output_modalities?: Array<"audio" | "text">;
  audio?: {
    output?: { voice?: VoiceId; speed?: number };
    input?: {
      transcription?: { model: string; language?: string | null; prompt?: string | null } | null;
      turn_detection?:
        | {
            type: "server_vad";
            threshold?: number;
            prefix_padding_ms?: number;
            silence_duration_ms?: number;
            create_response?: boolean;
            interrupt_response?: boolean;
          }
        | null;
      noise_reduction?: { type: "near_field" | "far_field" } | null;
    };
  };
}

export type ServerEvent =
  | { type: "session.created"; session: { id: string } }
  | { type: "session.updated"; session: unknown }
  | { type: "input_audio_buffer.speech_started"; item_id?: string }
  | { type: "input_audio_buffer.speech_stopped"; item_id?: string }
  | { type: "input_audio_buffer.committed"; item_id: string }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      transcript: string;
      item_id: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.failed";
      item_id: string;
      error: { message: string };
    }
  | { type: "response.created"; response: { id: string } }
  | {
      type: "response.audio_transcript.delta";
      delta: string;
      response_id: string;
      item_id: string;
    }
  | {
      type: "response.audio_transcript.done";
      transcript: string;
      response_id: string;
      item_id: string;
    }
  // GA API uses `output_audio_transcript.*` in some builds — model both
  | {
      type: "response.output_audio_transcript.delta";
      delta: string;
      response_id: string;
      item_id: string;
    }
  | {
      type: "response.output_audio_transcript.done";
      transcript: string;
      response_id: string;
      item_id: string;
    }
  | { type: "response.done"; response: { id: string; status: string } }
  | { type: "response.cancelled"; response_id: string }
  | { type: "error"; error: { type: string; message: string; code?: string } }
  // catch-all
  | { type: string; [k: string]: unknown };

export type ClientEvent =
  | { type: "session.update"; session: SessionConfig }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "input_audio_buffer.commit" }
  | { type: "input_audio_buffer.clear" }
  | { type: "response.create"; response?: { modalities?: Array<"text" | "audio"> } }
  | { type: "response.cancel" };
