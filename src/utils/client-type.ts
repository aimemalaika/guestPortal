export interface ClientType {
  osType: string;
  deviceType: string;
}

export function classifyClient(userAgent: string | undefined): ClientType {
  const agent = userAgent?.trim() ?? '';
  const normalized = agent.toLowerCase();

  let osType = 'UNKNOWN';
  if (normalized) {
    if (normalized.includes('cros')) osType = 'CHROME_OS';
    else if (normalized.includes('android')) osType = 'ANDROID';
    else if (/iphone|ipad|ipod/.test(normalized)) osType = 'IOS';
    else if (/windows/.test(normalized)) osType = 'WINDOWS';
    else if (/macintosh|mac os x/.test(normalized)) osType = 'MACOS';
    else if (normalized.includes('linux')) osType = 'LINUX';
    else osType = 'OTHER';
  }

  let deviceType = 'UNKNOWN';
  if (normalized) {
    if (/ipad|tablet|kindle|silk|playbook/.test(normalized) || (/android/.test(normalized) && !/mobile/.test(normalized))) {
      deviceType = 'TABLET';
    } else if (/mobile|iphone|ipod|windows phone/.test(normalized) || (/android/.test(normalized) && /mobile/.test(normalized))) {
      deviceType = 'MOBILE';
    } else if (osType !== 'OTHER') {
      deviceType = 'DESKTOP';
    } else {
      deviceType = 'OTHER';
    }
  }

  return { osType, deviceType };
}