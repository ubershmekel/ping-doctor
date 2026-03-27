export async function detectLocalIp(timeoutMs = 1500): Promise<string | null> {
  const RTC = (globalThis as Window & typeof globalThis & { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  if (!RTC) {
    return null;
  }

  return new Promise((resolve) => {
    const pc = new RTC({ iceServers: [] });
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) {
        return;
      }

      settled = true;
      pc.onicecandidate = null;
      pc.close();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    pc.createDataChannel('ip-check');
    pc.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate;
      if (!candidate) {
        return;
      }

      const match = candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      if (!match) {
        return;
      }

      clearTimeout(timer);
      finish(match[1]);
    };

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => {
        clearTimeout(timer);
        finish(null);
      });
  });
}

export function deriveRouterIp(localIp: string | null): string | null {
  if (!localIp) {
    return null;
  }

  const parts = localIp.split('.');
  if (parts.length !== 4) {
    return null;
  }

  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}
