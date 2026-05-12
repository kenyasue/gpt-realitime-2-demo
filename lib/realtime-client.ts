import type { ClientEvent, ServerEvent } from "./realtime-events";

export interface ConnectOpts {
  ephemeralKey: string;
  model: string;
  audioElement: HTMLAudioElement;
  onLocalStream?: (stream: MediaStream) => void;
}

export interface RealtimeClient {
  connect(opts: ConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  send(event: ClientEvent): void;
  on(handler: (event: ServerEvent) => void): () => void;
  isConnected(): boolean;
}

export function createRealtimeClient(): RealtimeClient {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let localStream: MediaStream | null = null;
  const handlers = new Set<(event: ServerEvent) => void>();
  let connected = false;

  function dispatch(event: ServerEvent) {
    handlers.forEach((h) => {
      try {
        h(event);
      } catch (err) {
        console.error("[realtime-client] handler error", err);
      }
    });
  }

  return {
    isConnected() {
      return connected;
    },

    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    send(event) {
      if (!dc || dc.readyState !== "open") {
        console.warn("[realtime-client] data channel not open, dropping event", event.type);
        return;
      }
      dc.send(JSON.stringify(event));
    },

    async connect({ ephemeralKey, model, audioElement, onLocalStream }) {
      if (pc) {
        throw new Error("RealtimeClient already connected. Call disconnect() first.");
      }

      const peer = new RTCPeerConnection();
      pc = peer;

      peer.ontrack = (e) => {
        const [stream] = e.streams;
        if (stream) {
          audioElement.srcObject = stream;
          audioElement.play().catch((err) => {
            console.warn("[realtime-client] audio autoplay blocked", err);
          });
        }
      };

      const channel = peer.createDataChannel("oai-events");
      dc = channel;

      channel.onopen = () => {
        connected = true;
      };

      channel.onclose = () => {
        connected = false;
      };

      channel.onmessage = (e) => {
        let parsed: ServerEvent;
        try {
          parsed = JSON.parse(e.data) as ServerEvent;
        } catch (err) {
          console.error("[realtime-client] failed to parse event", err, e.data);
          return;
        }
        dispatch(parsed);
      };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      localStream = stream;
      onLocalStream?.(stream);

      for (const track of stream.getTracks()) {
        peer.addTrack(track, stream);
      }

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      // GA SDP endpoint. The beta endpoint was /v1/realtime (no /calls suffix);
      // the GA realtime client_secrets API requires /v1/realtime/calls.
      const baseUrl = "https://api.openai.com/v1/realtime/calls";
      const sdpResponse = await fetch(`${baseUrl}?model=${encodeURIComponent(model)}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) {
        const detail = await sdpResponse.text().catch(() => "");
        throw new Error(
          `OpenAI Realtime SDP exchange failed: ${sdpResponse.status} ${sdpResponse.statusText} — ${detail.slice(0, 300)}`,
        );
      }

      const answerSdp = await sdpResponse.text();
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    },

    async disconnect() {
      connected = false;
      try {
        dc?.close();
      } catch {}
      dc = null;

      if (localStream) {
        for (const track of localStream.getTracks()) {
          track.stop();
        }
        localStream = null;
      }

      if (pc) {
        try {
          pc.getSenders().forEach((s) => {
            try {
              s.track?.stop();
            } catch {}
          });
          pc.close();
        } catch {}
        pc = null;
      }
    },
  };
}
