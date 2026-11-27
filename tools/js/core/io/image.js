// Image file -> RGBA, like Pillow's Image.open(path).convert("RGBA") in the Python tools.
import { isPng, decodePng } from './png.js';
import { isBmp, decodeBmp } from './bmp.js';

export class ImageError extends Error {}

export function decodeImage(bytes, name = 'image') {
  if (isPng(bytes)) return decodePng(bytes);
  if (isBmp(bytes)) return decodeBmp(bytes);
  throw new ImageError(`${name}: unknown image format`);
}
