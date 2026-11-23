declare const __WORKER_SOURCE__: string;
declare const __EXAMPLES__: {
  title: string;
  credit: string;
  href: string;
  filename: string;
  clip: string;
  source: string | null;
  sourceBytes: number;
  paper?: boolean;
  separate?: boolean;
}[];
declare module "gifenc" {
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, w: number, h: number, opts: { palette: number[][]; delay: number; repeat: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(data: Uint8ClampedArray, maxColors: number, opts: { format: string }): number[][];
  export function applyPalette(data: Uint8ClampedArray, palette: number[][], format: string): Uint8Array;
}
