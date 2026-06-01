export interface Region {
  id: string;
  type: "bubble" | "sfx";
  originalText: string;
  translatedText: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  textColor: string;
  strokeColor: string;
  strokeWidth: number;
  bgColor: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  textAlign: string;
  lineHeight: number;
  letterSpacing?: number;
  opacity?: number;
  autoFitText?: boolean;
  shadowColor?: string;
  shadowBlur?: number;
  bubbleContour?: number[];
}

export interface PaintStroke {
  tool: "erase" | "draw" | "fill_poly" | "bg_erase" | "smart_sfx" | "gen_erase";
  points: number[];
  color: string;
  size: number;
  imageBase64?: string;
  rect?: {x: number, y: number, w: number, h: number};
}

export interface ProcessedImage {
  id: string;
  filename: string;
  dataUrl: string;
  originalDataUrl?: string;
  mimeType: string;
  regions: Region[];
  paintStrokes: PaintStroke[];
  history?: { regions: Region[], paintStrokes: PaintStroke[] }[];
  status: "idle" | "processing" | "done" | "error";
  width: number;
  height: number;
  error?: string;
}

export interface CropSelection {
  id: string;
  sourceImageId: string;
  imageName: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cropUrl: string;
}

export interface Chapter {
  id: string;
  name: string;
  images: ProcessedImage[];
}

export interface Volume {
  id: string;
  name: string;
  chapters: Chapter[];
}

export interface MangaSeries {
  id: string;
  title: string;
  type: "manga" | "manhwa";
  coverUrl: string;
  description: string;
  volumes: Volume[];
}

