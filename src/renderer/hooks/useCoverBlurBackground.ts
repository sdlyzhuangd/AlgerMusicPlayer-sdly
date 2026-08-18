import { ref, watch } from 'vue';
import tinycolor from 'tinycolor2';

interface DominantColor {
  r: number;
  g: number;
  b: number;
}

export function useCoverBlurBackground() {
  const coverScrim = ref('rgba(0,0,0,0.18)');
  const _currentTrackId = ref<string | number | null>(null);

  const extractDominantColor = async (url: string): Promise<DominantColor | null> => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      const blob = new Blob([buf], {
        type: resp.headers.get('content-type') || 'image/jpeg'
      });
      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = objUrl;
      });
      URL.revokeObjectURL(objUrl);
      if (!img.naturalWidth || !img.naturalHeight) return null;

      const maxSize = 100;
      const scale = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.floor(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const colorCount: Record<string, number> = {};
      let dominant: DominantColor = { r: 0, g: 0, b: 0 };
      let maxCount = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const r = data[i] >> 3 << 3;
        const g = data[i + 1] >> 3 << 3;
        const b = data[i + 2] >> 3 << 3;
        const key = `${r},${g},${b}`;
        colorCount[key] = (colorCount[key] || 0) + 1;
        if (colorCount[key] > maxCount) {
          maxCount = colorCount[key];
          dominant = { r, g, b };
        }
      }
      return dominant;
    } catch (e) {
      console.warn('[CoverBlurBg] 取色失败，回退纯模糊背景:', e);
      return null;
    }
  };

  const _getBrightness = (r: number, g: number, b: number): number => {
    return Math.round((r * 299 + g * 587 + b * 114) / 1000);
  };

  const _lightenColor = (color: DominantColor, factor: number): DominantColor => {
    return {
      r: Math.min(255, Math.floor(color.r + (255 - color.r) * factor)),
      g: Math.min(255, Math.floor(color.g + (255 - color.g) * factor)),
      b: Math.min(255, Math.floor(color.b + (255 - color.b) * factor))
    };
  };

  const buildCoverScrim = (
    dominant: DominantColor | null,
    theme: 'light' | 'dark' = 'dark'
  ): string => {
    if (!dominant) {
      return theme === 'dark' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.2)';
    }
    if (theme === 'dark') {
      const c = {
        r: Math.floor(dominant.r * 0.4),
        g: Math.floor(dominant.g * 0.4),
        b: Math.floor(dominant.b * 0.4)
      };
      const alpha = 0.55;
      return `linear-gradient(to bottom, rgba(${c.r},${c.g},${c.b},${alpha}), rgba(${c.r},${c.g},${c.b},${(alpha * 0.5).toFixed(2)}))`;
    } else {
      let c = _lightenColor(dominant, 0.5);
      const br = _getBrightness(c.r, c.g, c.b);
      if (br < 100) {
        const rate = 100 / br;
        c = {
          r: Math.min(255, Math.floor(c.r * rate)),
          g: Math.min(255, Math.floor(c.g * rate)),
          b: Math.min(255, Math.floor(c.b * rate))
        };
      }
      const alpha = 0.6;
      return `linear-gradient(to bottom, rgba(${c.r},${c.g},${c.b},${alpha}), rgba(${c.r},${c.g},${c.b},${(alpha * 0.5).toFixed(2)}))`;
    }
  };

  const updateCoverBackground = async (
    coverUrl: string,
    trackId: string | number,
    theme: 'light' | 'dark' = 'dark',
    force = false
  ) => {
    if (!force && _currentTrackId.value === trackId) return;
    _currentTrackId.value = trackId;

    const dominant = await extractDominantColor(coverUrl);
    if (_currentTrackId.value !== trackId) return;
    coverScrim.value = buildCoverScrim(dominant, theme);
  };

  const getDominantColorFromPrimary = (
    primaryColor: string | undefined
  ): DominantColor | null => {
    if (!primaryColor) return null;
    const tc = tinycolor(primaryColor);
    if (!tc.isValid()) return null;
    const rgb = tc.toRgb();
    return { r: rgb.r, g: rgb.g, b: rgb.b };
  };

  const updateScrimFromPrimary = (
    primaryColor: string | undefined,
    theme: 'light' | 'dark' = 'dark'
  ) => {
    const dominant = getDominantColorFromPrimary(primaryColor);
    coverScrim.value = buildCoverScrim(dominant, theme);
  };

  return {
    coverScrim,
    updateCoverBackground,
    updateScrimFromPrimary
  };
}
