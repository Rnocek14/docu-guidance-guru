/**
 * Client-side device fingerprinting for fraud detection
 * Collects non-PII hardware/software characteristics to identify devices
 */

interface FingerprintComponents {
  canvas_hash: string;
  webgl_hash: string;
  audio_hash: string;
  fonts_hash: string;
  screen_resolution: string;
  timezone: string;
  language: string;
  platform: string;
  user_agent: string;
  hardware_concurrency: number;
  device_memory: number | null;
  touch_support: boolean;
}

// Simple hash function for fingerprint data
async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Canvas fingerprint
async function getCanvasFingerprint(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no-canvas';

    canvas.width = 200;
    canvas.height = 50;

    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Fingerprint', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('Canvas', 4, 17);

    return await hashString(canvas.toDataURL());
  } catch {
    return 'canvas-error';
  }
}

// WebGL fingerprint
async function getWebGLFingerprint(): Promise<string> {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'no-webgl';

    const webgl = gl as WebGLRenderingContext;
    const debugInfo = webgl.getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) return 'no-debug-info';

    const vendor = webgl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
    const renderer = webgl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);

    return await hashString(`${vendor}~${renderer}`);
  } catch {
    return 'webgl-error';
  }
}

// Audio context fingerprint
async function getAudioFingerprint(): Promise<string> {
  try {
    const AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof window.AudioContext }).webkitAudioContext;
    if (!AudioContext) return 'no-audio';

    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const analyser = context.createAnalyser();
    const gain = context.createGain();
    const processor = context.createScriptProcessor(4096, 1, 1);

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(10000, context.currentTime);

    gain.gain.setValueAtTime(0, context.currentTime);
    
    oscillator.connect(analyser);
    analyser.connect(processor);
    processor.connect(gain);
    gain.connect(context.destination);

    oscillator.start(0);

    const fingerprint = await new Promise<string>((resolve) => {
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          sum += Math.abs(data[i]);
        }
        oscillator.disconnect();
        processor.disconnect();
        context.close();
        resolve(sum.toString());
      };
      
      // Timeout fallback
      setTimeout(() => {
        oscillator.disconnect();
        processor.disconnect();
        context.close();
        resolve('audio-timeout');
      }, 1000);
    });

    return await hashString(fingerprint);
  } catch {
    return 'audio-error';
  }
}

// Installed fonts fingerprint (simplified)
async function getFontsFingerprint(): Promise<string> {
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const testFonts = [
    'Arial', 'Arial Black', 'Comic Sans MS', 'Courier New', 
    'Georgia', 'Impact', 'Times New Roman', 'Trebuchet MS', 
    'Verdana', 'Lucida Console', 'Lucida Sans Unicode',
    'Palatino Linotype', 'Tahoma', 'Microsoft Sans Serif'
  ];

  const testString = 'mmmmmmmmmmlli';
  const testSize = '72px';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'no-fonts';

  const baseWidths: Record<string, number> = {};
  baseFonts.forEach(font => {
    ctx.font = `${testSize} ${font}`;
    baseWidths[font] = ctx.measureText(testString).width;
  });

  const detectedFonts: string[] = [];
  testFonts.forEach(font => {
    let detected = false;
    baseFonts.forEach(baseFont => {
      ctx.font = `${testSize} '${font}', ${baseFont}`;
      const width = ctx.measureText(testString).width;
      if (width !== baseWidths[baseFont]) {
        detected = true;
      }
    });
    if (detected) {
      detectedFonts.push(font);
    }
  });

  return await hashString(detectedFonts.join(','));
}

/**
 * Collect all fingerprint components
 */
export async function collectFingerprint(): Promise<{
  hash: string;
  components: FingerprintComponents;
}> {
  const [canvasHash, webglHash, audioHash, fontsHash] = await Promise.all([
    getCanvasFingerprint(),
    getWebGLFingerprint(),
    getAudioFingerprint(),
    getFontsFingerprint(),
  ]);

  const components: FingerprintComponents = {
    canvas_hash: canvasHash,
    webgl_hash: webglHash,
    audio_hash: audioHash,
    fonts_hash: fontsHash,
    screen_resolution: `${screen.width}x${screen.height}x${screen.colorDepth}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    platform: navigator.platform,
    user_agent: navigator.userAgent,
    hardware_concurrency: navigator.hardwareConcurrency || 0,
    device_memory: (navigator as unknown as { deviceMemory?: number }).deviceMemory || null,
    touch_support: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
  };

  // Create combined hash
  const combinedString = Object.values(components).join('|');
  const hash = await hashString(combinedString);

  return { hash, components };
}

/**
 * Send fingerprint to server
 */
export async function submitFingerprint(
  supabaseUrl: string,
  authToken: string
): Promise<{ success: boolean; cluster_linked?: boolean; vpn_detected?: boolean }> {
  try {
    const { hash, components } = await collectFingerprint();

    const response = await fetch(`${supabaseUrl}/functions/v1/collect-fingerprint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        fingerprint_hash: hash,
        fingerprint_components: components,
      }),
    });

    if (!response.ok) {
      console.error('Fingerprint submission failed:', await response.text());
      return { success: false };
    }

    return await response.json();
  } catch (error) {
    console.error('Fingerprint collection error:', error);
    return { success: false };
  }
}
