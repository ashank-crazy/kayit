/**
 * The invitation card: one PNG with the ceremony, the host and a QR, made to be posted on WhatsApp
 * (chat or status), printed, or shown on a phone at the door. Drawn on a canvas with system fonts, so it
 * costs nothing to download.
 */
import qrcode from 'qrcode-generator';
import type { Ceremony } from '../core/protocol';
import { formatXof } from '../core/money';
import { t, fmtDate, type Key } from '../app/i18n';

const W = 1080;
const H = 1350;
const INK = '#1f2a5c';
const PAPER = '#fbf7ef';
const SAFFRON = '#e0a526';
const MUTED = '#6b6457';
const RULE = '#d9e2f2';
const MARGIN_RED = '#d64541';
const SANS = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, '') + '…';
    return kept;
  }
  return lines;
}

function drawQr(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number): void {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const cell = Math.floor(size / (n + quiet * 2));
  const real = cell * (n + quiet * 2);
  const ox = x + Math.floor((size - real) / 2);
  const oy = y + Math.floor((size - real) / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox, oy, real, real);
  ctx.fillStyle = '#111111';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell);
}

export function drawInviteCard(c: Ceremony, link: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // cahier paper: cream, blue rules, red margin
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 2;
  for (let y = 300; y < H; y += 56) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.strokeStyle = MARGIN_RED;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(84, 220);
  ctx.lineTo(84, H);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // header band
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, 220);
  ctx.fillStyle = SAFFRON;
  ctx.font = '800 96px Georgia, serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('K', 84, 112);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 54px ${SANS}`;
  ctx.fillText('Kayit', 170, 96);
  ctx.globalAlpha = 0.75;
  ctx.font = `400 32px ${SANS}`;
  ctx.fillText(t('invited_by', { host: c.hostName }), 170, 150);
  ctx.globalAlpha = 1;

  // ceremony
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = MUTED;
  ctx.font = `600 34px ${SANS}`;
  ctx.fillText(t(`t_${c.type}` as Key).toUpperCase(), 120, 300);
  ctx.fillStyle = INK;
  ctx.font = `800 68px ${SANS}`;
  const lines = wrap(ctx, c.title, W - 200, 2);
  lines.forEach((l, i) => ctx.fillText(l, 120, 385 + i * 78));
  let y = 385 + lines.length * 78;
  ctx.fillStyle = '#1d1b16';
  ctx.font = `500 40px ${SANS}`;
  const date = fmtDate(c.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  ctx.fillText(date.charAt(0).toUpperCase() + date.slice(1), 120, y + 6);
  y += 40;

  // QR on a white card
  const qrSize = 560;
  const qx = (W - qrSize) / 2;
  const qy = Math.max(y + 30, 560);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#e7dfcf';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(qx - 24, qy - 24, qrSize + 48, qrSize + 48, 28);
  ctx.fill();
  ctx.stroke();
  drawQr(ctx, link, qx, qy, qrSize);

  // call to action and pact
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = `700 40px ${SANS}`;
  ctx.fillText(t('card_scan'), W / 2, qy + qrSize + 92);
  if (c.capXof) {
    ctx.fillStyle = '#6b4a00';
    ctx.font = `600 32px ${SANS}`;
    // canvas fonts draw the narrow no-break space as nothing: use a plain no-break space
    ctx.fillText(t('card_cap', { amount: formatXof(c.capXof).replace(/\u202f/g, '\u00a0') }), W / 2, qy + qrSize + 146);
  }
  ctx.fillStyle = MUTED;
  ctx.font = `400 24px ${SANS}`;
  ctx.fillText(new URL(link).host, W / 2, H - 36);
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'));
}

/** Share the PNG through the phone's share sheet (WhatsApp, Telegram, SMS…); otherwise download it. */
export async function shareOrSave(blob: Blob, filename: string, text: string): Promise<'shared' | 'saved'> {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'saved';
}

export function cardFilename(c: Ceremony): string {
  const slug = c.title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `kayit-${slug || 'invitation'}.png`;
}
