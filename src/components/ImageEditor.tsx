import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Stage, Layer, Image as KonvaImage, Rect, Text, Group, Transformer, Line } from 'react-konva';
import useImage from 'use-image';
import { ProcessedImage, Region, PaintStroke } from '../types';

interface ImageEditorProps {
  image: ProcessedImage;
  selectedRegionId: string | null;
  onSelectRegion: (id: string | null) => void;
  onUpdateRegion: (id: string, updates: Partial<Region>) => void;
  stageRef: React.RefObject<any>;
  activeTool: 'select' | 'draw' | 'erase' | 'fill_poly' | 'bg_erase' | 'smart_sfx' | 'gen_erase';
  brushSize: number;
  brushColor: string;
  zoom: number;
  showOriginal?: boolean;
  showText?: boolean;
  onAddStroke: (stroke: PaintStroke) => void;
  onGenerateInpaint?: (base64: string) => Promise<string>;
}

const AIInpaintPatch = ({ base64, rect }: { base64: string, rect: {x: number, y: number, w: number, h: number} }) => {
  const [img] = useImage(base64);
  if (!img || !rect) return null;
  return <KonvaImage image={img} x={rect.x} y={rect.y} width={rect.w} height={rect.h} />;
};

export function ImageEditor({ 
  image, 
  selectedRegionId, 
  onSelectRegion, 
  onUpdateRegion, 
  stageRef,
  activeTool,
  brushSize,
  brushColor,
  zoom,
  showOriginal,
  showText = true,
  onAddStroke,
  onGenerateInpaint
}: ImageEditorProps) {
  const bgToUse = showOriginal && image.originalDataUrl ? image.originalDataUrl : image.dataUrl;
  const [img] = useImage(bgToUse);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const trRef = useRef<any>(null);
  const shapeRefs = useRef<{ [key: string]: any }>({});
  
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<PaintStroke | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      const resize = () => {
        if (containerRef.current) {
          setSize({
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight
          });
        }
      };
      
      resize();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }
  }, []);

  useEffect(() => {
    if (selectedRegionId && shapeRefs.current[selectedRegionId]) {
      trRef.current?.nodes([shapeRefs.current[selectedRegionId]]);
      trRef.current?.getLayer()?.batchDraw();
    } else {
      trRef.current?.nodes([]);
    }
  }, [selectedRegionId, activeTool]);

  const baseScale = img ? Math.min((size.width - 40) / image.width, (size.height - 40) / image.height) : 1;
  const scale = baseScale * zoom;

  const stageWidth = img ? image.width * scale : size.width;
  const stageHeight = img ? image.height * scale : size.height;

  const getPixelColor = (x: number, y: number) => {
    if (!img) return '#ffffff';
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '#ffffff';
    ctx.drawImage(img, -x, -y);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  };

  const handleMouseDown = (e: any) => {
    if (activeTool === 'select') {
      const clickedOnEmpty = e.target === e.target.getStage() || e.target.name() === 'bgImage';
      if (clickedOnEmpty) {
        onSelectRegion(null);
      }
      return;
    }

    const pos = e.target.getStage().getPointerPosition();
    if (!pos) return;
    
    const x = pos.x / scale;
    const y = pos.y / scale;

    let initialColor = brushColor;
    if (activeTool === 'draw' || activeTool === 'fill_poly') initialColor = brushColor;
    else if (activeTool === 'erase') initialColor = '#ffffff';
    else if (activeTool === 'bg_erase') initialColor = '#000000';
    else if (activeTool === 'gen_erase') initialColor = 'rgba(236, 72, 153, 0.5)'; // Pink translucent for masking
    else if (activeTool === 'smart_sfx') initialColor = getPixelColor(x, y);

    if (activeTool === 'fill_poly') {
      if (!currentStroke || currentStroke.tool !== 'fill_poly') {
         setIsDrawing(true);
         setCurrentStroke({ tool: 'fill_poly', points: [x, y], color: initialColor, size: 0 });
      } else {
         const newPoints = [...currentStroke.points, x, y];
         if (newPoints.length === 8) {
           onAddStroke({ ...currentStroke, points: newPoints });
           setCurrentStroke(null);
           setIsDrawing(false);
         } else {
           setCurrentStroke({ ...currentStroke, points: newPoints });
         }
      }
      return;
    }

    setIsDrawing(true);
    setCurrentStroke({
      tool: activeTool,
      points: [x, y],
      color: initialColor,
      size: brushSize / scale
    });
  };

  const handleMouseMove = (e: any) => {
    if (!isDrawing || !currentStroke) return;
    if (activeTool === 'fill_poly') return; 

    const stage = e.target.getStage();
    const pos = stage.getPointerPosition();
    if (!pos) return;

    const x = pos.x / scale;
    const y = pos.y / scale;

    setCurrentStroke({
      ...currentStroke,
      points: currentStroke.points.concat([x, y])
    });
  };

  const [isGenerating, setIsGenerating] = useState(false);

  const handleMouseUp = async () => {
    if (activeTool === 'fill_poly') return; 
    if (isDrawing && currentStroke) {
      setIsDrawing(false);
      let finalStroke = { ...currentStroke };

      if (activeTool === 'gen_erase' && img && finalStroke.points.length >= 4 && onGenerateInpaint) {
        setIsGenerating(true);
        try {
          // Calculate bounding box of the stroke
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (let i = 0; i < finalStroke.points.length; i += 2) {
            minX = Math.min(minX, finalStroke.points[i]);
            maxX = Math.max(maxX, finalStroke.points[i]);
            minY = Math.min(minY, finalStroke.points[i+1]);
            maxY = Math.max(maxY, finalStroke.points[i+1]);
          }
          
          // Pad to get context and make it a square (better for GenAI)
          const pad = (finalStroke.size / 2) + 20;
          minX = Math.max(0, minX - pad);
          maxX = Math.min(img.width - 1, maxX + pad);
          minY = Math.max(0, minY - pad);
          maxY = Math.min(img.height - 1, maxY + pad);

          const w = maxX - minX;
          const h = maxY - minY;
          const size = Math.max(w, h); // Square dimensions
          
          // Center the square
          const centerX = minX + w / 2;
          const centerY = minY + h / 2;
          const sMinX = Math.max(0, centerX - size / 2);
          const sMinY = Math.max(0, centerY - size / 2);
          const sMaxX = Math.min(img.width - 1, centerX + size / 2);
          const sMaxY = Math.min(img.height - 1, centerY + size / 2);
          
          const sW = sMaxX - sMinX;
          const sH = sMaxY - sMinY;

          if (sW > 0 && sH > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = sW; canvas.height = sH;
            const ctx = canvas.getContext('2d');
            
            if (ctx) {
              ctx.drawImage(img, sMinX, sMinY, sW, sH, 0, 0, sW, sH);
              const dataUrl = canvas.toDataURL('image/jpeg', 1.0);
              const base64Crop = dataUrl.split(',')[1];
              
              const generatedBase64 = await onGenerateInpaint(base64Crop);
              
              finalStroke.imageBase64 = generatedBase64;
              finalStroke.rect = { x: sMinX, y: sMinY, w: sW, h: sH };
            }
          }
        } catch (error) {
          console.error("Generative inpaint failed", error);
          alert("Failed to run AI Inpainting. " + (error as Error).message);
        } finally {
          setIsGenerating(false);
        }
      }

      onAddStroke(finalStroke);
      setCurrentStroke(null);
    }
  };

  const allStrokes = useMemo(() => image.paintStrokes.concat(currentStroke ? [currentStroke] : []), [image.paintStrokes, currentStroke]);
  const normalStrokes = allStrokes.filter(s => s.tool !== 'bg_erase');
  const bgEraseStrokes = allStrokes.filter(s => s.tool === 'bg_erase');

  return (
    <div 
      ref={containerRef} 
      className={`w-full h-full bg-slate-900 rounded-lg overflow-auto relative ${activeTool !== 'select' ? 'cursor-crosshair' : 'cursor-default'}`}
    >
      <div 
        style={{ 
          width: Math.max(size.width, stageWidth), 
          height: Math.max(size.height, stageHeight),
          position: 'relative'
        }}
      >
        {isGenerating && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm rounded-lg" style={{ width: stageWidth, height: stageHeight, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
            <div className="flex flex-col items-center gap-3 text-white">
              <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="font-medium text-sm">AI Inpainting in progress...</p>
            </div>
          </div>
        )}
        <div 
          style={{ 
            position: 'absolute', 
            left: '50%', top: '50%', 
            transform: 'translate(-50%, -50%)', 
            width: stageWidth, height: stageHeight 
          }}
        >
          <Stage
            width={stageWidth}
            height={stageHeight}
            scaleX={scale}
            scaleY={scale}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            ref={stageRef}
          >
            {/* Layer 1: Image & normal paint strokes */}
            <Layer>
              {img && (
                <KonvaImage
                  image={img}
                  name="bgImage"
                />
              )}

              {!showOriginal && normalStrokes.map((stroke, i) => (
                stroke.imageBase64 && stroke.rect ? (
                  <AIInpaintPatch key={i} base64={stroke.imageBase64} rect={stroke.rect} />
                ) : (
                  <Line
                    key={i}
                    points={stroke.points}
                    stroke={stroke.tool === 'fill_poly' ? (stroke.points.length === 8 ? 'transparent' : stroke.color) : stroke.color}
                    strokeWidth={stroke.tool === 'fill_poly' ? Math.max(1, stroke.size) : stroke.size}
                    fill={stroke.tool === 'fill_poly' ? stroke.color : undefined}
                    closed={stroke.tool === 'fill_poly'}
                    tension={stroke.tool === 'fill_poly' ? 0 : 0.5}
                    lineCap="round"
                    lineJoin="round"
                  />
                )
              ))}
            </Layer>

            {/* Layer 2: Region Backgrounds & bg_erase strokes (with destination-out hole punching) */}
            {!showOriginal && (
              <Layer>
                {image.regions.map((region) => (
                  region.bgColor !== 'transparent' && (
                    <Group
                      key={region.id}
                      x={region.x + region.width / 2}
                      y={region.y + region.height / 2}
                      rotation={region.angle}
                      offset={{ x: region.width / 2, y: region.height / 2 }}
                    >
                      <Rect
                        width={region.width}
                        height={region.height}
                        fill={region.bgColor}
                        cornerRadius={region.type === 'bubble' ? 10 : 0}
                      />
                    </Group>
                  )
                ))}
                
                {/* Apply destination-out to punching holes exactly into the solid backgrounds above */}
                {bgEraseStrokes.map((stroke, i) => (
                  <Line
                    key={i}
                    points={stroke.points}
                    stroke="black"
                    strokeWidth={stroke.size}
                    globalCompositeOperation="destination-out"
                    tension={0.5}
                    lineCap="round"
                    lineJoin="round"
                  />
                ))}
              </Layer>
            )}

            {/* Layer 3: Texts and Transformer */}
            {!showOriginal && showText && (
              <Layer>
                {image.regions.map((region) => (
                  <Group
                    key={region.id}
                    name={region.id}
                    x={region.x}
                    y={region.y}
                    width={region.width}
                    height={region.height}
                    rotation={region.angle}
                    draggable={activeTool === 'select'}
                    onClick={() => activeTool === 'select' && onSelectRegion(region.id)}
                    onTap={() => activeTool === 'select' && onSelectRegion(region.id)}
                    ref={(node) => {
                      if (node) shapeRefs.current[region.id] = node;
                    }}
                    onDragMove={(e) => {
                      if (activeTool !== 'select') return;
                      onUpdateRegion(region.id, {
                        x: e.target.x(),
                        y: e.target.y()
                      });
                    }}
                    onDragEnd={(e) => {
                      if (activeTool !== 'select') return;
                      onUpdateRegion(region.id, {
                        x: e.target.x(),
                        y: e.target.y()
                      });
                    }}
                    onTransformEnd={(e) => {
                      if (activeTool !== 'select') return;
                      const node = shapeRefs.current[region.id];
                      const scaleX = node.scaleX();
                      const scaleY = node.scaleY();
                      
                      node.scaleX(1);
                      node.scaleY(1);

                      onUpdateRegion(region.id, {
                        x: node.x(),
                        y: node.y(),
                        width: Math.max(5, node.width() * scaleX),
                        height: Math.max(5, node.height() * scaleY),
                        angle: node.rotation()
                      });
                    }}
                  >
                    <Rect width={region.width} height={region.height} fill="transparent" />
                    <Text
                      text={region.translatedText ? region.translatedText.split('\n').map(line => '\u202B' + line + '\u200F').join('\n') : ''}
                      width={region.width}
                      height={region.height}
                      fill={region.textColor}
                      stroke={region.strokeColor !== 'transparent' ? region.strokeColor : undefined}
                      strokeWidth={region.strokeColor !== 'transparent' ? region.strokeWidth : 0}
                      fontFamily={region.fontFamily}
                      fontSize={region.fontSize}
                      fontStyle={`${region.fontStyle} ${region.fontWeight === 'normal' ? '' : region.fontWeight}`}
                      align={region.textAlign}
                      verticalAlign="middle"
                      wrap="word"
                      lineHeight={region.lineHeight}
                      fillAfterStrokeEnabled={true}
                    />
                  </Group>
                ))}
                
                {selectedRegionId && activeTool === 'select' && (
                  <Transformer
                    ref={trRef}
                    boundBoxFunc={(oldBox, newBox) => {
                      if (newBox.width < 10 || newBox.height < 10) return oldBox;
                      return newBox;
                    }}
                  />
                )}
              </Layer>
            )}
          </Stage>
        </div>
      </div>
    </div>
  );
}
