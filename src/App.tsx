import React, { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { Upload, Download, Play, Save, Loader2, Image as ImageIcon, Type as TypeIcon, MousePointer2, Brush, Eraser, PenTool, ZoomIn, ZoomOut, Maximize, Palette, Plus, Pipette, Trash2, ChevronUp, ChevronDown, ImagePlus, Key, Sparkles, Scissors, Undo, Wand2, Settings } from 'lucide-react';
import { extractImagesFromZip, downloadProcessedZip, downloadPdf, downloadSingleImage } from './lib/zip';
import { processMangaPages, generateInpaint, RawRegion } from './lib/gemini';
import { floodFillBubble, floodFillBubbleDetailed } from './lib/bubbleDetect';
import { createTranslationDoc, parseTranslationDoc } from './lib/translationDoc';
import { ProcessedImage, Region, PaintStroke, CropSelection, MangaSeries, Volume, Chapter } from './types';
import { get, set } from 'idb-keyval';
import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';
import JSZip from 'jszip';
import { writePsd } from 'ag-psd';
import 'ag-psd/initialize-canvas';

const ImageEditor = React.lazy(() => import('./components/ImageEditor').then(m => ({ default: m.ImageEditor })));

type Tool = 'select' | 'draw' | 'erase' | 'fill_poly' | 'bg_erase' | 'smart_sfx' | 'gen_erase' | 'crop';

export default function App() {
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [selectedForProcess, setSelectedForProcess] = useState<Set<string>>(new Set());
  const [bubblePreviews, setBubblePreviews] = useState<{ [imgId: string]: any[] }>({});
  const [showBubblePreviews, setShowBubblePreviews] = useState(false);
  const [isGeneratingPreviews, setIsGeneratingPreviews] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const importFontRef = useRef<HTMLInputElement>(null);

  const [customFonts, setCustomFonts] = useState<{name: string, family: string}[]>([]);

  // Manga Hierarchical Library state
  const [mangas, setMangas] = useState<MangaSeries[]>([]);
  const [activeMangaId, setActiveMangaId] = useState<string | null>(null);
  const [activeVolumeId, setActiveVolumeId] = useState<string | null>(null);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);

  // Series Creator Modal state
  const [showCreateSeriesModal, setShowCreateSeriesModal] = useState(false);
  const [newSeriesTitle, setNewSeriesTitle] = useState('');
  const [newSeriesType, setNewSeriesType] = useState<'manga' | 'manhwa'>('manga');
  const [newSeriesDesc, setNewSeriesDesc] = useState('');
  const [newSeriesCoverUrl, setNewSeriesCoverUrl] = useState('');
  const coverFileInputRef = useRef<HTMLInputElement>(null);

  // Load hierarchical projects on mount
  useEffect(() => {
    get('mangas_library').then((saved) => {
      if (saved && Array.isArray(saved) && saved.length > 0) {
        setMangas(saved);
      } else {
        // Fallback or migration from previous legacy session
        get('manga_project').then((legacyImages) => {
          if (legacyImages && Array.isArray(legacyImages) && legacyImages.length > 0) {
            const defaultManga: MangaSeries = {
              id: 'legacy-manga-' + Math.random().toString(36).substr(2, 9),
              title: 'Solo Leveling (Cleaned)',
              type: 'manhwa',
              coverUrl: '', // auto beautiful gradient
              description: 'Imported from previous workspace session.',
              volumes: [
                {
                  id: 'legacy-volume-1',
                  name: 'Volume 1',
                  chapters: [
                    {
                      id: 'legacy-chapter-1',
                      name: 'Chapter 1',
                      images: legacyImages
                    }
                  ]
                }
              ]
            };
            setMangas([defaultManga]);
            set('mangas_library', [defaultManga]).catch(console.error);
            
            // Auto open the chapter
            setActiveMangaId(defaultManga.id);
            setActiveVolumeId('legacy-volume-1');
            setActiveChapterId('legacy-chapter-1');
            setImages(legacyImages);
            setSelectedImageId(legacyImages[0].id);
          }
        }).catch(console.error);
      }
    }).catch(console.error);
  }, []);

  // Save changes to mangas_library when state updates
  useEffect(() => {
    if (mangas.length > 0) {
      const timeout = setTimeout(() => {
        set('mangas_library', mangas).catch(console.error);
      }, 1000);
      return () => clearTimeout(timeout);
    }
  }, [mangas]);

  // Sync editor modifications back into the active Chapter
  useEffect(() => {
    if (activeMangaId && activeVolumeId && activeChapterId) {
      setMangas(prev => prev.map(manga => {
        if (manga.id !== activeMangaId) return manga;
        return {
          ...manga,
          volumes: manga.volumes.map(vol => {
            if (vol.id !== activeVolumeId) return vol;
            return {
              ...vol,
              chapters: vol.chapters.map(chap => {
                if (chap.id !== activeChapterId) return chap;
                return { ...chap, images: images };
              })
            };
          })
        };
      }));
    }
  }, [images, activeMangaId, activeVolumeId, activeChapterId]);
  
  // Settings State
  const [customApiKey, setCustomApiKey] = useState('');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [customInstructions, setCustomInstructions] = useState('');
  const [translateJapanese, setTranslateJapanese] = useState(true);
  const [translateSfx, setTranslateSfx] = useState(true);
  const [zipMatchMode, setZipMatchMode] = useState<'filename' | 'index'>('filename');

  const [autoFitAndCenter, setAutoFitAndCenter] = useState<boolean>(() => {
    return localStorage.getItem('manga_auto_fit_and_center') !== 'false';
  });
  const [compressBeforeProcessing, setCompressBeforeProcessing] = useState<boolean>(() => {
    return localStorage.getItem('manga_compress_before_processing') !== 'false';
  });
  const [cropsQueue, setCropsQueue] = useState<CropSelection[]>([]);

  const [appInitializing, setAppInitializing] = useState(true);
  const [activeNavigationTab, setActiveNavigationTab] = useState<'library' | 'cloud' | 'scheduler' | 'settings'>('library');
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAppInitializing(false);
    }, 2200);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const savedKey = localStorage.getItem('manga_gemini_key');
    if (savedKey) setCustomApiKey(savedKey);
    const savedInst = localStorage.getItem('manga_custom_instructions');
    if (savedInst) setCustomInstructions(savedInst);
    const savedTransJp = localStorage.getItem('manga_translate_jp');
    if (savedTransJp !== null) setTranslateJapanese(savedTransJp === 'true');
    const savedTransSfx = localStorage.getItem('manga_translate_sfx');
    if (savedTransSfx !== null) setTranslateSfx(savedTransSfx === 'true');
    const savedMatchMode = localStorage.getItem('manga_zip_match_mode');
    if (savedMatchMode) setZipMatchMode(savedMatchMode as any);
    
    const savedAutoFit = localStorage.getItem('manga_auto_fit_and_center');
    if (savedAutoFit !== null) setAutoFitAndCenter(savedAutoFit === 'true');
    const savedCompress = localStorage.getItem('manga_compress_before_processing');
    if (savedCompress !== null) setCompressBeforeProcessing(savedCompress === 'true');
    
    // Preload Arabic fonts
    const fontsToLoad = [
      "Cairo", "Tajawal", "Marhey", "Aref Ruqaa", "El Messiri", "Amiri", 
      "Changa", "Harmattan", "Katibeh", "Lalezar", "Lemonada", "Mada", 
      "Markazi Text", "Reem Kufi", "Rakkas", "Almarai"
    ];
    if ('fonts' in document) {
      Promise.all(fontsToLoad.map(font => (document as any).fonts.load(`12px "${font}"`)))
        .catch(console.error);
    }
  }, []);

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const val = e.target.value;
    setCustomApiKey(val);
    localStorage.setItem('manga_gemini_key', val);
  };

  const handleCustomInstructionsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setCustomInstructions(val);
    localStorage.setItem('manga_custom_instructions', val);
  };

  const handleSetTranslateJapanese = (val: boolean) => {
    setTranslateJapanese(val);
    localStorage.setItem('manga_translate_jp', String(val));
  };

  const handleSetTranslateSfx = (val: boolean) => {
    setTranslateSfx(val);
    localStorage.setItem('manga_translate_sfx', String(val));
  };
  
  const handleSetZipMatchMode = (val: 'filename' | 'index') => {
    setZipMatchMode(val);
    localStorage.setItem('manga_zip_match_mode', val);
  };
  
  const handleSetAutoFitAndCenter = (val: boolean) => {
    setAutoFitAndCenter(val);
    localStorage.setItem('manga_auto_fit_and_center', String(val));
  };

  const handleSetCompressBeforeProcessing = (val: boolean) => {
    setCompressBeforeProcessing(val);
    localStorage.setItem('manga_compress_before_processing', String(val));
  };

  const compressImageBase64 = async (base64: string, maxDim: number = 1600, quality: number = 0.85): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = base64;
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width <= maxDim && height <= maxDim) {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/jpeg', quality));
            return;
          }
        }
        if (width > height) {
          if (width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          }
        } else {
          if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } else {
          resolve(base64);
        }
      };
      img.onerror = () => resolve(base64);
    });
  };
  
  // Editor State
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [brushSize, setBrushSize] = useState(20);
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [zoom, setZoom] = useState(1);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showText, setShowText] = useState(true);

  const [manhwaMode, setManhwaMode] = useState<boolean>(() => {
    return localStorage.getItem('manhwa_mode') === 'true';
  });
  const [isProcessingCrop, setIsProcessingCrop] = useState(false);

  const selectedImage = images.find(img => img.id === selectedImageId);
  const selectedRegion = selectedImage?.regions.find(r => r.id === selectedRegionId);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts if user is typing in an input or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedImageId && selectedRegionId) {
          saveHistory(selectedImageId);
          setImages(prev => prev.map(img => {
            if (img.id === selectedImageId) {
              return { ...img, regions: img.regions.filter(r => r.id !== selectedRegionId) };
            }
            return img;
          }));
          setSelectedRegionId(null);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (selectedImageId) {
          undo(selectedImageId);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
         // Maybe add action to select all? Though we don't have multiple select regions right now.
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedImageId, selectedRegionId, images]);

  const handleSaveProject = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(images));
    const a = document.createElement('a');
    a.href = dataStr;
    a.download = "manga_project.json";
    a.click();
  };

  const handleLoadProject = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        setImages(data);
        if (data.length > 0) setSelectedImageId(data[0].id);
      } catch (err) {
        alert("Invalid project file.");
      }
    };
    reader.readAsText(file);
    if (projectInputRef.current) projectInputRef.current.value = '';
  };

  const handleZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Swal.fire({
      title: 'Importing Manga Pages...',
      text: 'Please wait while we unpack the archive and prepare the pages.',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
      background: '#120b24',
      color: '#f8fafc'
    });

    try {
      const extractedImages = await extractImagesFromZip(file);
      setImages(extractedImages);
      if (extractedImages.length > 0) {
        setSelectedImageId(extractedImages[0].id);
      }
      Swal.close();
      
      Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: 'Archive Imported!',
        text: `Successfully loaded ${extractedImages.length} images into the library.`,
        showConfirmButton: false,
        timer: 2000,
        background: '#120b24',
        color: '#f8fafc'
      });
    } catch (error) {
      console.error("Error reading zip", error);
      Swal.fire({
        icon: 'error',
        title: 'ZIP Import Failed',
        text: 'The archive might be corrupted or in an unsupported format.',
        confirmButtonColor: '#7c3aed',
        background: '#120b24',
        color: '#f8fafc'
      });
    }
  };

  const cleanZipInputRef = useRef<HTMLInputElement>(null);

  const handleCleanedZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    Swal.fire({
      title: 'Merging Cleaned Plates...',
      text: 'Matching the whitened manga sheets against original page indices...',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      },
      background: '#120b24',
      color: '#f8fafc'
    });

    try {
      const cleanedImages = await extractImagesFromZip(file);
      if (cleanedImages.length === 0) {
        Swal.fire({
          icon: 'warning',
          title: 'Empty Clean Archive',
          text: 'No matching cleaned image sheets were found in the uploaded file.',
          confirmButtonColor: '#eab308',
          background: '#120b24',
          color: '#f8fafc'
        });
        return;
      }

      setImages(prev => {
        const newImages = [...prev];
        for (let i = 0; i < cleanedImages.length; i++) {
          const cleanInfo = cleanedImages[i];
          let targetIndex = -1;
          
          if (zipMatchMode === 'filename') {
             targetIndex = newImages.findIndex(img => img.filename === cleanInfo.filename);
             if (targetIndex === -1) targetIndex = i; // fallback to index if names don't match
          } else {
             targetIndex = i;
          }
          
          if (targetIndex < newImages.length) {
             const target = newImages[targetIndex];
             // Save current as original if not already set, then swap dataUrl
             const originalDataUrl = target.originalDataUrl || target.dataUrl;
             
             // Remove backgrounds from regions as the image is already cleaned
             const newRegions = target.regions.map(r => ({ ...r, bgColor: 'transparent' }));
             // Remove all paint strokes, since the user only wants texts over the cleaned image
             const newStrokes: PaintStroke[] = [];
             
             newImages[targetIndex] = {
               ...target,
               originalDataUrl,
               dataUrl: cleanInfo.dataUrl,
               regions: newRegions,
               paintStrokes: newStrokes
             };
          }
        }
        return newImages;
      });
      
      Swal.fire({
        icon: 'success',
        title: 'Manga Cleaning Plates Merged!',
        text: 'Successfully swapped original sheets for whitened plates. Use the "View Original" toggle to inspect any changes.',
        confirmButtonColor: '#7c3aed',
        background: '#120b24',
        color: '#f8fafc'
      });
    } catch (error) {
      console.error("Error reading cleaned zip", error);
      Swal.fire({
        icon: 'error',
        title: 'Clean Plate Import Failed',
        text: 'Could not successfully swap or process image paths: ' + (error as Error).message,
        confirmButtonColor: '#ef4444',
        background: '#120b24',
        color: '#f8fafc'
      });
    }
    if (cleanZipInputRef.current) cleanZipInputRef.current.value = '';
  };

  const updateImage = (imgId: string, updates: Partial<ProcessedImage>) => {
    setImages(prev => prev.map(img => img.id === imgId ? { ...img, ...updates } : img));
  };

  const saveHistory = (imgId: string) => {
    setImages(prev => prev.map(img => {
      if (img.id === imgId) {
        const currentHistory = img.history || [];
        const newHistory = [...currentHistory, {
          regions: JSON.parse(JSON.stringify(img.regions)),
          paintStrokes: JSON.parse(JSON.stringify(img.paintStrokes))
        }].slice(-20); // Keep last 20 steps
        return { ...img, history: newHistory };
      }
      return img;
    }));
  };

  const undo = (imgId: string) => {
    setImages(prev => prev.map(img => {
      if (img.id === imgId) {
        const history = img.history || [];
        if (history.length === 0) return img;
        const prevState = history[history.length - 1];
        const newHistory = history.slice(0, -1);
        return {
          ...img,
          regions: prevState.regions,
          paintStrokes: prevState.paintStrokes,
          history: newHistory
        };
      }
      return img;
    }));
  };

  const updateRegion = (regionId: string, updates: Partial<Region>) => {
    if (!selectedImageId) return;
    setImages(prev => prev.map(img => {
      if (img.id !== selectedImageId) return img;
      return {
        ...img,
        regions: img.regions.map(r => r.id === regionId ? { ...r, ...updates } : r)
      };
    }));
  };

  const handleSmartBubbleFill = async (imgId: string, region: Region) => {
    if (region.type === 'sfx') {
      alert("خوارزمية التعرف الذكي على الفقاعات مخصصة للفقاعات فقط وتتجاهل المؤثرات الصوتية (SFX).");
      return;
    }
    const img = images.find(i => i.id === imgId);
    if (!img) return;

    // Use the whitened/inpainted image dataUrl strictly so text strokes don't block flood fill
    const imgSrc = img.dataUrl;
    const imageObj = new Image();
    imageObj.src = imgSrc;
    await new Promise(resolve => imageObj.onload = resolve);

    const canvas = document.createElement('canvas');
    canvas.width = imageObj.width;
    canvas.height = imageObj.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.drawImage(imageObj, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    const startX = Math.floor(region.x + region.width / 2);
    const startY = Math.floor(region.y + region.height / 2);
    
    const result = floodFillBubbleDetailed(imageData, startX, startY, region.width, region.height);
    
    if (result) {
      saveHistory(img.id);
      updateRegion(region.id, {
        ...result.safeTextBounds,
        bubbleContour: result.contour,
        textAlign: 'center'
      });
    } else {
      alert("تعذر التعرف التلقائي على حدود الفقاعة.");
    }
  };

  const handleCenterText = (regionId: string) => {
    saveHistory(selectedImageId!);
    updateRegion(regionId, { textAlign: 'center' }); // usually already handled, but we can also snap to center of parent bubble if preferred
  };

  const traceRegionsWithBubbleDetection = async (imgDataUrl: string, regions: Region[]): Promise<Region[]> => {
    try {
      const imageObj = new Image();
      imageObj.src = imgDataUrl;
      await new Promise((resolve) => {
        imageObj.onload = resolve;
        imageObj.onerror = resolve;
      });

      const canvas = document.createElement('canvas');
      canvas.width = imageObj.width;
      canvas.height = imageObj.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return regions;

      ctx.drawImage(imageObj, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      return regions.map(region => {
        if (region.type === 'bubble') {
          const startX = Math.floor(region.x + region.width / 2);
          const startY = Math.floor(region.y + region.height / 2);
          const result = floodFillBubbleDetailed(imageData, startX, startY, region.width, region.height);
          if (result) {
            return {
              ...region,
              ...result.safeTextBounds,
              bubbleContour: result.contour,
              textAlign: 'center'
            };
          }
        }
        return region;
      });
    } catch (e) {
      console.error("Error auto-tracing bubbles:", e);
      return regions;
    }
  };

  const handleProcessCropSection = async (rect: { x: number, y: number, w: number, h: number }) => {
    const img = images.find(i => i.id === selectedImageId);
    if (!img) return;

    setIsProcessingCrop(true);
    try {
      const imgSrc = img.originalDataUrl || img.dataUrl;
      const imageObj = new Image();
      imageObj.src = imgSrc;
      await new Promise((resolve, reject) => {
        imageObj.onload = resolve;
        imageObj.onerror = reject;
      });

      const canvas = document.createElement('canvas');
      canvas.width = rect.w;
      canvas.height = rect.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error("Unable to create canvas 2D context");
      }

      // Draw only the cropped section
      ctx.drawImage(imageObj, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      const croppedBase64DataUrl = canvas.toDataURL('image/jpeg', 0.95);

      const key = customApiKey || '';
      
      const results = await processMangaPages(
        [{ id: 'crop-temp', base64Image: croppedBase64DataUrl, mimeType: 'image/jpeg' }],
        key,
        customInstructions,
        translateJapanese,
        translateSfx
      );

      const rawRegions = results[0]?.regions || [];
      if (rawRegions.length === 0) {
        Swal.fire({
          icon: 'info',
          title: 'No Texts Found',
          text: 'The AI model could not detect any text or bubbles in this specified crop segment.',
          background: '#120b24',
          color: '#f8fafc',
          confirmButtonColor: '#7c3aed'
        });
        return;
      }

      // Project regions back to the master image coordinate system
      let newRegions: Region[] = rawRegions.map((raw, idx) => {
        const cx = (raw.xmin / 1000) * rect.w;
        const cy = (raw.ymin / 1000) * rect.h;
        const cw = ((raw.xmax - raw.xmin) / 1000) * rect.w;
        const ch = ((raw.ymax - raw.ymin) / 1000) * rect.h;

        const rx = rect.x + cx;
        const ry = rect.y + cy;

        return {
          id: `region_${Date.now()}_crop_${idx}`,
          type: raw.type || 'bubble',
          originalText: raw.originalText || '',
          translatedText: raw.translatedText || '',
          x: rx,
          y: ry,
          width: cw,
          height: ch,
          angle: raw.angle || 0,
          textColor: raw.textColor || '#000000',
          strokeColor: raw.strokeColor || 'transparent',
          strokeWidth: raw.strokeWidth ?? 0,
          bgColor: img.originalDataUrl ? 'transparent' : (raw.bgColor && raw.bgColor !== 'transparent' ? raw.bgColor : (raw.type === 'bubble' ? '#ffffff' : 'transparent')),
          fontFamily: raw.fontFamily || (raw.type === 'bubble' ? 'Cairo' : 'Aref Ruqaa'),
          fontSize: raw.fontSize || Math.max(14, Math.floor(ch / 4.2)),
          fontWeight: raw.fontWeight || 'normal',
          fontStyle: raw.fontStyle || 'normal',
          textAlign: raw.textAlign || 'center',
          lineHeight: 1.25,
          autoFitText: true
        };
      });

      // Automatically trace contours and center alignment of newly created bubble regions if enabled!
      if (autoFitAndCenter) {
        newRegions = await traceRegionsWithBubbleDetection(imgSrc, newRegions);
      }

      saveHistory(img.id);
      updateImage(img.id, {
        regions: [...img.regions, ...newRegions]
      });

      if (newRegions.length > 0) {
        setSelectedRegionId(newRegions[0].id);
      }

      Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: 'Translated Successfully!',
        showConfirmButton: false,
        timer: 1500,
        timerProgressBar: true,
        background: '#120b24',
        color: '#f8fafc'
      });

    } catch (err) {
      console.error("AI Cropped Translate error:", err);
      Swal.fire({
        icon: 'error',
        title: 'Translation Failed',
        text: 'An error occurred during crop segment translation: ' + (err as Error).message,
        confirmButtonColor: '#ef4444',
        background: '#120b24',
        color: '#f8fafc'
      });
    } finally {
      setIsProcessingCrop(false);
    }
  };

  const handleQueueCropSection = async (rect: { x: number, y: number, w: number, h: number }) => {
    const img = images.find(i => i.id === selectedImageId);
    if (!img) return;

    try {
      const imgSrc = img.originalDataUrl || img.dataUrl;
      const imageObj = new Image();
      imageObj.src = imgSrc;
      await new Promise((resolve, reject) => {
        imageObj.onload = resolve;
        imageObj.onerror = reject;
      });

      const canvas = document.createElement('canvas');
      canvas.width = rect.w;
      canvas.height = rect.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(imageObj, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
      const croppedBase64DataUrl = canvas.toDataURL('image/jpeg', 0.90);

      const newCrop: CropSelection = {
        id: `crop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        sourceImageId: img.id,
        imageName: img.filename,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        cropUrl: croppedBase64DataUrl
      };

      setCropsQueue(prev => [...prev, newCrop]);

      Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: 'Added to Batch Queue',
        text: `Segment bounding [${Math.round(rect.w)}x${Math.round(rect.h)}] saved to batch pipeline.`,
        showConfirmButton: false,
        timer: 2000,
        timerProgressBar: true,
        background: '#120b24',
        color: '#f8fafc',
        customClass: {
          popup: 'backdrop-blur-md bg-purple-950/90 border border-purple-800/80 rounded-xl shadow-2xl'
        }
      });

    } catch (e) {
      console.error("Error cropping section for queue:", e);
      Swal.fire({
        icon: 'error',
        title: 'Crop Segment Error',
        text: 'Failed to write cropped canvas data: ' + (e as Error).message,
        confirmButtonColor: '#ef4444',
        background: '#120b24',
        color: '#f8fafc'
      });
    }
  };

  const handleTranslateCropQueue = async () => {
    if (cropsQueue.length === 0) {
      Swal.fire({
        icon: 'warning',
        title: 'Crop Queue is Empty',
        text: 'Please crop at least one segment first using the Crop tool, then proceed with translation.',
        confirmButtonColor: '#7c3aed',
        background: '#120b24',
        color: '#f8fafc'
      });
      return;
    }

    setIsProcessingCrop(true);
    try {
      const loadedImages: { selection: CropSelection; imgElement: HTMLImageElement }[] = [];
      for (const item of cropsQueue) {
        const imgObj = new Image();
        imgObj.src = item.cropUrl;
        await new Promise((resolve) => {
          imgObj.onload = resolve;
          imgObj.onerror = resolve;
        });
        loadedImages.push({ selection: item, imgElement: imgObj });
      }

      const spacing = 30; 
      const canvasWidth = Math.max(...cropsQueue.map(c => c.w), 800); 
      let totalStitchedHeight = 0;
      
      const renderSpecs = loadedImages.map((lm, idx) => {
        const item = lm.selection;
        const scale = canvasWidth / item.w;
        const renderedH = item.h * scale;
        const yOffset = totalStitchedHeight;
        totalStitchedHeight += renderedH + (idx < loadedImages.length - 1 ? spacing : 0);
        return {
          ...item,
          imgElement: lm.imgElement,
          scale,
          renderedW: canvasWidth,
          renderedH,
          yOffset
        };
      });

      const canvas = document.createElement('canvas');
      canvas.width = canvasWidth;
      canvas.height = totalStitchedHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error("Unable to create stitched canvas");
      }

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasWidth, totalStitchedHeight);

      renderSpecs.forEach((spec) => {
        ctx.drawImage(spec.imgElement, 0, spec.yOffset, spec.renderedW, spec.renderedH);
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, spec.yOffset, spec.renderedW, spec.renderedH);
      });

      const stitchedBase64DataUrl = canvas.toDataURL('image/jpeg', 0.88);
      const key = customApiKey || '';

      const results = await processMangaPages(
        [{ id: 'stitched-crop', base64Image: stitchedBase64DataUrl, mimeType: 'image/jpeg' }],
        key,
        customInstructions,
        translateJapanese,
        translateSfx
      );

      const rawRegions = results[0]?.regions || [];
      if (rawRegions.length === 0) {
        Swal.fire({
          icon: 'info',
          title: 'No Texts Found',
          text: 'The Gemini AI model did not detect any text regions in the crop segments.',
          confirmButtonColor: '#7c3aed',
          background: '#120b24',
          color: '#f8fafc'
        });
        return;
      }

      const updatesGroupedByImage: { [imageId: string]: Region[] } = {};

      for (let idx = 0; idx < rawRegions.length; idx++) {
        const raw = rawRegions[idx];

        const stitchedX = (raw.xmin / 1000) * canvasWidth;
        const stitchedY = (raw.ymin / 1000) * totalStitchedHeight;
        const stitchedW = ((raw.xmax - raw.xmin) / 1000) * canvasWidth;
        const stitchedH = ((raw.ymax - raw.ymin) / 1000) * totalStitchedHeight;

        const centerY = stitchedY + stitchedH / 2;
        const matchedSpec = renderSpecs.find(spec => centerY >= spec.yOffset && centerY <= (spec.yOffset + spec.renderedH + spacing));
        if (!matchedSpec) continue; 

        const relYStitched = stitchedY - matchedSpec.yOffset;
        const relXStitched = stitchedX; 

        const relXOriginalSub = relXStitched / matchedSpec.scale;
        const relYOriginalSub = relYStitched / matchedSpec.scale;
        const relWOriginalSub = stitchedW / matchedSpec.scale;
        const relHOriginalSub = stitchedH / matchedSpec.scale;

        const origX = matchedSpec.x + relXOriginalSub;
        const origY = matchedSpec.y + relYOriginalSub;
        const origW = relWOriginalSub;
        const origH = relHOriginalSub;

        const rId = `region_${Date.now()}_queued_crop_${idx}`;
        const region: Region = {
          id: rId,
          type: raw.type || 'bubble',
          originalText: raw.originalText || '',
          translatedText: raw.translatedText || '',
          x: origX,
          y: origY,
          width: origW,
          height: origH,
          angle: raw.angle || 0,
          textColor: raw.textColor || '#000000',
          strokeColor: raw.strokeColor || 'transparent',
          strokeWidth: raw.strokeWidth ?? 0,
          bgColor: 'transparent', 
          fontFamily: raw.fontFamily || (raw.type === 'bubble' ? 'Cairo' : 'Aref Ruqaa'),
          fontSize: raw.fontSize || Math.max(14, Math.floor(origH / 4.2)),
          fontWeight: raw.fontWeight || 'normal',
          fontStyle: raw.fontStyle || 'normal',
          textAlign: raw.textAlign || 'center',
          lineHeight: 1.25,
          autoFitText: true
        };

        if (!updatesGroupedByImage[matchedSpec.sourceImageId]) {
          updatesGroupedByImage[matchedSpec.sourceImageId] = [];
        }
        updatesGroupedByImage[matchedSpec.sourceImageId].push(region);
      }

      let totalAddedCount = 0;
      for (const [imgId, newRegs] of Object.entries(updatesGroupedByImage)) {
        const matchingImg = images.find(i => i.id === imgId);
        if (!matchingImg) continue;

        let finalRegsForImg = newRegs;
        if (autoFitAndCenter) {
          finalRegsForImg = await traceRegionsWithBubbleDetection(matchingImg.originalDataUrl || matchingImg.dataUrl, newRegs);
        }

        saveHistory(imgId);
        updateImage(imgId, {
          regions: [...matchingImg.regions, ...finalRegsForImg]
        });
        totalAddedCount += finalRegsForImg.length;
      }

      setCropsQueue([]);

      Swal.fire({
        icon: 'success',
        title: 'Batch Translation Complete!',
        text: `Processed crops and localized ${totalAddedCount} translated text bubbled regions directly on their matching original sheets.`,
        confirmButtonColor: '#7c3aed',
        background: '#120b24',
        color: '#f8fafc'
      });

    } catch (err) {
      console.error("Batch Queue translate error:", err);
      Swal.fire({
        icon: 'error',
        title: 'Batch Translation Failed',
        text: 'An error occurred during multi-crop Gemini API processing: ' + (err as Error).message,
        confirmButtonColor: '#ef4444',
        background: '#120b24',
        color: '#f8fafc'
      });
    } finally {
      setIsProcessingCrop(false);
    }
  };

  const handleSmartBubbleFillAll = async (imgId: string) => {
    const img = images.find(i => i.id === imgId);
    if (!img) return;

    // Use the whitened/inpainted image dataUrl strictly
    const imgSrc = img.dataUrl;
    const imageObj = new Image();
    imageObj.src = imgSrc;
    await new Promise(resolve => imageObj.onload = resolve);

    const canvas = document.createElement('canvas');
    canvas.width = imageObj.width;
    canvas.height = imageObj.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    ctx.drawImage(imageObj, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    const newRegions = [...img.regions];
    let changed = false;

    for (let i = 0; i < newRegions.length; i++) {
       const region = newRegions[i];
       if (region.type === 'bubble') { // ignores SFX completely
         const startX = Math.floor(region.x + region.width / 2);
         const startY = Math.floor(region.y + region.height / 2);
         const result = floodFillBubbleDetailed(imageData, startX, startY, region.width, region.height);
         if (result) {
           newRegions[i] = { 
             ...region, 
             ...result.safeTextBounds,
             bubbleContour: result.contour,
             textAlign: 'center'
           };
           changed = true;
         }
       }
    }
    
    if (changed) {
      saveHistory(img.id);
      updateImage(img.id, { regions: newRegions });
    } else {
      alert("No text bubbles were detected for dynamic improvement on this page.");
    }
  };

  const generateBubblePreviews = async (imgId: string) => {
    const img = images.find(i => i.id === imgId);
    if (!img) return;

    setIsGeneratingPreviews(true);
    try {
      // Use the whitened/inpainted image dataUrl strictly
      const imgSrc = img.dataUrl;
      const imageObj = new Image();
      imageObj.src = imgSrc;
      await new Promise(resolve => imageObj.onload = resolve);

      const canvas = document.createElement('canvas');
      canvas.width = imageObj.width;
      canvas.height = imageObj.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      ctx.drawImage(imageObj, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      const previews: any[] = [];

      for (const region of img.regions) {
        if (region.type === 'bubble') { // ignore SFX regions
          const startX = Math.floor(region.x + region.width / 2);
          const startY = Math.floor(region.y + region.height / 2);
          const result = floodFillBubbleDetailed(imageData, startX, startY, region.width, region.height);
          if (result) {
            previews.push({
              regionId: region.id,
              contour: result.contour, // exact fluid polygon outline points
              safeTextBounds: result.safeTextBounds
            });
          }
        }
      }
      
      setBubblePreviews(prev => ({ ...prev, [imgId]: previews }));
      setShowBubblePreviews(true);
    } catch (e) {
      console.error(e);
      alert("تعذر تشغيل المعاينة التلقائية للفقاعات.");
    } finally {
      setIsGeneratingPreviews(false);
    }
  };

  const applyBubblePreviews = (imgId: string) => {
    const list = bubblePreviews[imgId];
    if (!list || list.length === 0) return;
    
    saveHistory(imgId);
    setImages(prev => prev.map(img => {
      if (img.id !== imgId) return img;
      return {
        ...img,
        regions: img.regions.map(region => {
          const preview = list.find(p => p.regionId === region.id);
          if (preview) {
            return {
              ...region,
              ...preview.safeTextBounds,
              bubbleContour: preview.contour,
              textAlign: 'center'
            };
          }
          return region;
        })
      };
    }));
    
    setShowBubblePreviews(false);
  };

  const toggleSelectForProcess = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSet = new Set(selectedForProcess);
    const keysList = customApiKey.split(/[\s,\n]+/).map(k => k.trim()).filter(Boolean);
    const maxSelect = 5 * Math.max(1, keysList.length);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      if (newSet.size >= maxSelect) {
        alert(`You can select up to ${maxSelect} images based on your API key list (5 per key).`);
        return;
      }
      newSet.add(id);
    }
    setSelectedForProcess(newSet);
  };

  const runParallelMangaTranslation = async (batch: ProcessedImage[]) => {
    const keysList = customApiKey.split(/[\s,\n]+/).map(k => k.trim()).filter(Boolean);
    const keysToUse = keysList.length > 0 ? keysList : [''];
    
    // Chunk batch into groups of 5
    const chunks: ProcessedImage[][] = [];
    for (let i = 0; i < batch.length; i += 5) {
      chunks.push(batch.slice(i, i + 5));
    }
    
    const maxConcurrent = keysToUse.length;
    
    // Process matching the number of keys concurrently
    for (let i = 0; i < chunks.length; i += maxConcurrent) {
      const currentChunks = chunks.slice(i, i + maxConcurrent);
      
      await Promise.all(currentChunks.map(async (chunk, index) => {
        const key = keysToUse[index % keysToUse.length];
        
        // Mark all in chunk as processing
        chunk.forEach(img => updateImage(img.id, { status: 'processing', error: undefined }));
        
        try {
          const processedPages = await Promise.all(chunk.map(async img => {
            const srcBase64 = img.originalDataUrl || img.dataUrl;
            let imgBase64 = srcBase64;
            let mimeType = img.mimeType;
            if (compressBeforeProcessing) {
              try {
                imgBase64 = await compressImageBase64(srcBase64, 1600, 0.82);
                mimeType = 'image/jpeg';
              } catch (e) {
                console.error("Compression failed for img:", img.id, e);
              }
            }
            return { id: img.id, base64Image: imgBase64, mimeType };
          }));

          const chunkResults = await processMangaPages(
            processedPages, 
            key,
            customInstructions,
            translateJapanese,
            translateSfx
          );
          
          await Promise.all(chunkResults.map(async result => {
            const img = chunk.find(b => b.id === result.id);
            if (!img) return;
            
            const newRegions: Region[] = result.regions.map(raw => {
              const x = (raw.xmin / 1000) * img.width;
              const y = (raw.ymin / 1000) * img.height;
              const width = ((raw.xmax - raw.xmin) / 1000) * img.width;
              const height = ((raw.ymax - raw.ymin) / 1000) * img.height;
              
              return {
                id: Math.random().toString(36).substr(2, 9),
                type: raw.type,
                originalText: raw.originalText,
                translatedText: raw.translatedText,
                x, y, width, height,
                angle: raw.angle || 0,
                textColor: raw.textColor || '#000000',
                strokeColor: raw.strokeColor || 'transparent',
                strokeWidth: raw.strokeWidth ?? 0,
                bgColor: img.originalDataUrl ? 'transparent' : (raw.bgColor && raw.bgColor !== 'transparent' ? raw.bgColor : (raw.type === 'bubble' ? '#ffffff' : 'transparent')),
                fontFamily: raw.fontFamily || (raw.type === 'bubble' ? 'Marhey' : 'Aref Ruqaa'),
                fontSize: raw.fontSize || Math.max(16, Math.floor(height / 4)),
                fontWeight: raw.fontWeight || 'normal',
                fontStyle: raw.fontStyle || 'normal',
                textAlign: raw.textAlign || 'center',
                lineHeight: raw.lineHeight || 1.2,
                letterSpacing: 0,
                opacity: 1,
                shadowBlur: 0,
                shadowColor: 'transparent',
                autoFitText: true
              };
            });
            
            let finalRegions = newRegions;
            if (autoFitAndCenter) {
              finalRegions = await traceRegionsWithBubbleDetection(img.originalDataUrl || img.dataUrl, newRegions);
            }
            
            updateImage(img.id, { status: 'done', regions: finalRegions });
          }));
        } catch (err: any) {
          chunk.forEach(img => updateImage(img.id, { status: 'error', error: err.message }));
        }
      }));
    }
  };

  const processSelectedImages = async () => {
    if (selectedForProcess.size === 0) return;
    const batch = images.filter(img => selectedForProcess.has(img.id) && img.status !== 'done');
    if (batch.length === 0) {
       setSelectedForProcess(new Set());
       return;
    }
    
    await runParallelMangaTranslation(batch);
    setSelectedForProcess(new Set());
  };

  const processAllImages = async () => {
    setIsProcessingAll(true);
    const uncompleted = images.filter(img => img.status !== 'done');
    await runParallelMangaTranslation(uncompleted);
    setIsProcessingAll(false);
  };
  
  const processImage = async (img: ProcessedImage) => {
    if (img.status === 'processing') return;
    updateImage(img.id, { status: 'processing', error: undefined });
    
    try {
      const keysList = customApiKey.split(/[\s,\n]+/).map(k => k.trim()).filter(Boolean);
      const key = keysList[0] || '';
      
      const srcBase64 = img.originalDataUrl || img.dataUrl;
      let imgBase64 = srcBase64;
      let mimeType = img.mimeType;
      
      if (compressBeforeProcessing) {
        try {
          imgBase64 = await compressImageBase64(srcBase64, 1600, 0.82);
          mimeType = 'image/jpeg';
        } catch (e) {
          console.error("Compression failed for single image:", e);
        }
      }

      const results = await processMangaPages([{ id: img.id, base64Image: imgBase64, mimeType: mimeType }], key, customInstructions, translateJapanese, translateSfx);
      const rawRegions = results[0]?.regions || [];
      
      const newRegions: Region[] = rawRegions.map(raw => {
        // Map 0-1000 to pixel coordinates
        const x = (raw.xmin / 1000) * img.width;
        const y = (raw.ymin / 1000) * img.height;
        const width = ((raw.xmax - raw.xmin) / 1000) * img.width;
        const height = ((raw.ymax - raw.ymin) / 1000) * img.height;

        return {
          id: Math.random().toString(36).substr(2, 9),
          type: raw.type,
          originalText: raw.originalText,
          translatedText: raw.translatedText,
          x,
          y,
          width,
          height,
          angle: raw.angle || 0,
          textColor: raw.textColor || '#000000',
          strokeColor: raw.strokeColor || 'transparent',
          strokeWidth: raw.strokeWidth ?? 0,
          bgColor: img.originalDataUrl ? 'transparent' : (raw.bgColor && raw.bgColor !== 'transparent' ? raw.bgColor : (raw.type === 'bubble' ? '#ffffff' : 'transparent')),
          fontFamily: raw.fontFamily || (raw.type === 'bubble' ? 'Marhey' : 'Aref Ruqaa'),
          fontSize: raw.fontSize || Math.max(16, Math.floor(height / 4)),
          fontWeight: raw.fontWeight || 'normal',
          fontStyle: raw.fontStyle || 'normal',
          textAlign: raw.textAlign || 'center',
          lineHeight: raw.lineHeight || 1.2,
          letterSpacing: 0,
          opacity: 1,
          shadowBlur: 0,
          shadowColor: 'transparent',
          autoFitText: true
        };
      });

      let finalRegions = newRegions;
      if (autoFitAndCenter) {
        finalRegions = await traceRegionsWithBubbleDetection(srcBase64, newRegions);
      }

      updateImage(img.id, { status: 'done', regions: finalRegions });
    } catch (error: any) {
      updateImage(img.id, { status: 'error', error: error.message });
    }
  };

  // Helper handlers for library hierarchy
  const handleOpenChapter = (chap: Chapter) => {
    setActiveChapterId(chap.id);
    setImages(chap.images);
    if (chap.images.length > 0) {
      setSelectedImageId(chap.images[0].id);
    } else {
      setSelectedImageId(null);
    }
  };

  const handleDeleteManga = (mangaId: string) => {
    Swal.fire({
      title: 'هل ترغب بحذف هذه المانجا كلياً من المكتبة؟',
      text: "سيؤدي هذا الإجراء لحذف كافة المجلدات والفصول والصفحات المترجمة نهائياً ولا يمكن الرجوع فيه!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'نعم، احذف السلسلة',
      cancelButtonText: 'إلغاء',
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#374151',
      background: '#120b24',
      color: '#f8fafc'
    }).then((result) => {
      if (result.isConfirmed) {
        setMangas(prev => prev.filter(m => m.id !== mangaId));
        if (activeMangaId === mangaId) {
          setActiveMangaId(null);
          setActiveVolumeId(null);
          setActiveChapterId(null);
        }
        Swal.fire({
          icon: 'success',
          text: 'تم حذف سلسلة المانجا بنجاح!',
          confirmButtonColor: '#7c3aed',
          background: '#120b24',
          color: '#f8fafc'
        });
      }
    });
  };

  const handleDeleteVolume = (volId: string) => {
    Swal.fire({
      title: 'هل تريد حذف هذا المجلد وجسد فصوله؟',
      text: "سيتم حذف المجلد بكافة الفصول الموجودة بداخله نهائياً!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'نعم، احذفه',
      cancelButtonText: 'إلغاء',
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#374151',
      background: '#120b24',
      color: '#f8fafc'
    }).then((result) => {
      if (result.isConfirmed) {
        setMangas(prev => prev.map(m => {
          if (m.id !== activeMangaId) return m;
          return {
            ...m,
            volumes: m.volumes.filter(v => v.id !== volId)
          };
        }));
        if (activeVolumeId === volId) {
          setActiveVolumeId(null);
          setActiveChapterId(null);
        }
        Swal.fire({
          icon: 'success',
          text: 'تم حذف المجلد بنجاح!',
          confirmButtonColor: '#7c3aed',
          background: '#120b24',
          color: '#f8fafc'
        });
      }
    });
  };

  const handleDeleteChapter = (chapId: string) => {
    Swal.fire({
      title: 'هل تريد حذف هذا الشابتر كلياً؟',
      text: "سيؤدي هذا لحذف كافة الصور المغروسة والتعديلات المطبقة نهائياً!",
      icon: 'warning',
      showCancelButton: true,
      confirmButtonText: 'نعم، احذفه',
      cancelButtonText: 'إلغاء',
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#374151',
      background: '#120b24',
      color: '#f8fafc'
    }).then((result) => {
      if (result.isConfirmed) {
        setMangas(prev => prev.map(m => {
          if (m.id !== activeMangaId) return m;
          return {
            ...m,
            volumes: m.volumes.map(v => {
              if (v.id !== activeVolumeId) return v;
              return {
                ...v,
                chapters: v.chapters.filter(c => c.id !== chapId)
              };
            })
          };
        }));
        if (activeChapterId === chapId) {
          setActiveChapterId(null);
          setImages([]);
        }
        Swal.fire({
          icon: 'success',
          text: 'تم حذف الشابتر المترجم بنجاح!',
          confirmButtonColor: '#7c3aed',
          background: '#120b24',
          color: '#f8fafc'
        });
      }
    });
  };

  const handleAddVolumePrompt = () => {
    Swal.fire({
      title: 'إضافة مجلد جديد (New Volume)',
      text: 'أدخل اسم المجلد أو رقمه الترتيبي للتصنيف:',
      input: 'text',
      inputPlaceholder: 'مثلا: Volume 20 أو مجلد 1...',
      showCancelButton: true,
      confirmButtonText: 'إضافة المجلد',
      cancelButtonText: 'إلغاء',
      confirmButtonColor: '#7c3aed',
      background: '#120b24',
      color: '#f8fafc',
      inputValidator: (value) => {
        if (!value) {
          return 'يجب كتابة اسم المجلد!';
        }
        return null;
      }
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        const value = result.value.trim();
        const newVol: Volume = {
          id: 'volume-' + Math.random().toString(36).substr(2, 9),
          name: value,
          chapters: []
        };
        setMangas(prev => prev.map(m => {
          if (m.id !== activeMangaId) return m;
          return {
            ...m,
            volumes: [...m.volumes, newVol]
          };
        }));
        Swal.fire({
          icon: 'success',
          text: `تمت إضافة المجلد ${value} بنجاح!`,
          confirmButtonColor: '#7c3aed',
          background: '#120b24',
          color: '#f8fafc'
        });
      }
    });
  };

  const handleAddChapterPrompt = () => {
    Swal.fire({
      title: 'إضافة شابتر جديد (New Chapter)',
      text: 'أدخل رقم الفصل أو اسم الجزء لحساب الترجمة:',
      input: 'text',
      inputPlaceholder: 'مثلا: Chapter 150 أو الفصل الأول...',
      showCancelButton: true,
      confirmButtonText: 'إنشاء الفصل',
      cancelButtonText: 'إلغاء',
      confirmButtonColor: '#7c3aed',
      background: '#120b24',
      color: '#f8fafc',
      inputValidator: (value) => {
        if (!value) {
          return 'يجب كتابة اسم الفصل!';
        }
        return null;
      }
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        const value = result.value.trim();
        const newChap: Chapter = {
          id: 'chapter-' + Math.random().toString(36).substr(2, 9),
          name: value,
          images: []
        };
        setMangas(prev => prev.map(m => {
          if (m.id !== activeMangaId) return m;
          return {
            ...m,
            volumes: m.volumes.map(v => {
              if (v.id !== activeVolumeId) return v;
              return {
                ...v,
                chapters: [...v.chapters, newChap]
              };
            })
          };
        }));
        
        // Auto enter chapter directly as workspace!
        handleOpenChapter(newChap);
      }
    });
  };

  const handleCoverUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 2 * 1024 * 1024) {
        Swal.fire({
          icon: 'warning',
          text: 'يرجى اختيار صورة بحجم أصغر من 2 ميجابايت لضمان سرعة الأداء.',
          confirmButtonColor: '#7c3aed',
          background: '#120b24',
          color: '#f8fafc'
        });
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setNewSeriesCoverUrl(reader.result);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCreateSeries = () => {
    if (!newSeriesTitle.trim()) {
      Swal.fire({
        icon: 'error',
        text: 'يجب كتابة عنوان المانجا/المانهوا للبدء!',
        confirmButtonColor: '#7c3aed',
        background: '#120b24',
        color: '#f8fafc'
      });
      return;
    }

    const newManga: MangaSeries = {
      id: 'manga-' + Math.random().toString(36).substr(2, 9),
      title: newSeriesTitle.trim(),
      type: newSeriesType,
      coverUrl: newSeriesCoverUrl || '', 
      description: newSeriesDesc.trim() || 'لا يوجد وصف مخصص لهذه السلسلة.',
      volumes: []
    };

    setMangas(prev => [...prev, newManga]);
    
    // Clear and close
    setNewSeriesTitle('');
    setNewSeriesType('manga');
    setNewSeriesDesc('');
    setNewSeriesCoverUrl('');
    setShowCreateSeriesModal(false);

    Swal.fire({
      icon: 'success',
      text: 'تمت إضافة السلسلة الجديدة لمكتبتك بنجاح! انقر عليها الآن لإنشاء المجلدات والفصول.',
      confirmButtonColor: '#7c3aed',
      background: '#120b24',
      color: '#f8fafc'
    });
  };

  const loadDemoProject = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1200;
    const ctx = canvas.getContext('2d');
    if (ctx) {
       // Canvas background
       ctx.fillStyle = '#f3f4f6';
       ctx.fillRect(0, 0, 800, 1200);
       
       // Panel borders
       ctx.strokeStyle = '#111827';
       ctx.lineWidth = 6;
       ctx.strokeRect(30, 30, 740, 340);
       ctx.strokeRect(30, 400, 350, 760);
       ctx.strokeRect(410, 400, 360, 760);
       
       // Decorative manga speedlines background
       ctx.strokeStyle = '#d1d5db';
       ctx.lineWidth = 1.5;
       for (let i = 0; i < 20; i++) {
         ctx.beginPath();
         ctx.moveTo(35 + i * 18, 35);
         ctx.lineTo(210 + i * 8, 365);
         ctx.stroke();
       }
       
       // Draw dialogue bubble outline 1
       ctx.fillStyle = '#ffffff';
       ctx.strokeStyle = '#000000';
       ctx.lineWidth = 4;
       ctx.beginPath();
       ctx.ellipse(200, 150, 90, 60, 0, 0, Math.PI * 2);
       ctx.fill();
       ctx.stroke();
       // tail
       ctx.beginPath();
       ctx.moveTo(170, 200);
       ctx.lineTo(150, 250);
       ctx.lineTo(210, 195);
       ctx.fillStyle = '#ffffff';
       ctx.fill();
       ctx.stroke();
       ctx.beginPath();
       ctx.moveTo(171, 198);
       ctx.lineTo(209, 193);
       ctx.strokeStyle = '#ffffff';
       ctx.lineWidth = 6;
       ctx.stroke();
       
       // Draw dialogue bubble outline 2
       ctx.fillStyle = '#ffffff';
       ctx.strokeStyle = '#000000';
       ctx.lineWidth = 4;
       ctx.beginPath();
       ctx.ellipse(580, 700, 100, 70, 0, 0, Math.PI * 2);
       ctx.fill();
       ctx.stroke();
       // tail
       ctx.beginPath();
       ctx.moveTo(550, 755);
       ctx.lineTo(530, 810);
       ctx.lineTo(590, 750);
       ctx.fillStyle = '#ffffff';
       ctx.fill();
       ctx.stroke();
       ctx.beginPath();
       ctx.moveTo(551, 753);
       ctx.lineTo(589, 748);
       ctx.strokeStyle = '#ffffff';
       ctx.lineWidth = 6;
       ctx.stroke();
    }
    const dataUrl = canvas.toDataURL();
    
    // Seed high precision mock boxes to make it immediately interactive
    const demoRegions: Region[] = [
      {
        id: "demo-bubble-1",
        type: "bubble",
        originalText: "本当に？マンガ翻訳AIがついに完成したのか？！",
        translatedText: "Really? The manga translation AI is finally complete?!",
        x: 120,
        y: 110,
        width: 160,
        height: 80,
        angle: 0,
        textColor: "#000000",
        strokeColor: "transparent",
        strokeWidth: 2,
        bgColor: "transparent",
        fontFamily: "Inter",
        fontSize: 16,
        fontWeight: "600",
        fontStyle: "normal",
        textAlign: "center",
        lineHeight: 1.3
      },
      {
        id: "demo-bubble-2",
        type: "bubble",
        originalText: "ええ、素晴らしい流動ガラスのUIを備えています！",
        translatedText: "Yes, featuring a gorgeous liquid glass UI edition!",
        x: 495,
        y: 650,
        width: 170,
        height: 100,
        angle: 0,
        textColor: "#000000",
        strokeColor: "transparent",
        strokeWidth: 2,
        bgColor: "transparent",
        fontFamily: "Inter",
        fontSize: 16,
        fontWeight: "650",
        fontStyle: "normal",
        textAlign: "center",
        lineHeight: 1.3
      }
    ];

    const demoImage: ProcessedImage = {
       id: "demo-project-ch1",
       filename: "demo_manga_page_01.png",
       dataUrl,
       mimeType: "image/png",
       regions: demoRegions,
       paintStrokes: [],
       status: "done",
       width: 800,
       height: 1200
    };

    const demoMangaId = 'demo-manga-150';
    const demoVolumeId = 'demo-volume-20';
    const demoChapterId = 'demo-chapter-150';

    const newDemoManga: MangaSeries = {
      id: demoMangaId,
      title: 'Solo Leveling (Demo)',
      type: 'manhwa',
      coverUrl: '', // Auto colorful dark gradient
      description: 'The legendary webtoon Solo Leveling loaded with pre-segmented dialogues, custom fonts and automated OCR regions.',
      volumes: [
        {
          id: demoVolumeId,
          name: 'Volume 20',
          chapters: [
            {
              id: demoChapterId,
              name: 'Chapter 150',
              images: [demoImage]
            }
          ]
        }
      ]
    };

    setMangas(prev => {
      const exists = prev.some(m => m.id === demoMangaId);
      if (exists) {
        return prev.map(m => m.id === demoMangaId ? newDemoManga : m);
      }
      return [...prev, newDemoManga];
    });

    setActiveMangaId(demoMangaId);
    setActiveVolumeId(demoVolumeId);
    setActiveChapterId(demoChapterId);
    setImages([demoImage]);
    setSelectedImageId(demoImage.id);
    setActiveNavigationTab('library');
    Swal.fire({
      icon: 'success',
      text: 'Interactive sample demo project loaded! Select individual speech bubbles to translate, realign, or change fonts.',
      confirmButtonColor: '#7c3aed',
      background: '#120b24',
      color: '#f8fafc'
    });
  };

  const appendImagesInputRef = useRef<HTMLInputElement>(null);

  const handleAppendImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const newImages: ProcessedImage[] = [];
    for (let i = 0; i < files.length; i++) {
       const file = files[i];
       const dataUrl = await new Promise<string>((resolve) => {
           const reader = new FileReader();
           reader.onload = (ev) => resolve(ev.target?.result as string);
           reader.readAsDataURL(file);
       });
       const dimensions = await new Promise<{width: number, height: number}>((resolve) => {
           const img = new Image();
           img.onload = () => resolve({ width: img.width, height: img.height });
           img.src = dataUrl;
       });
       newImages.push({
           id: Math.random().toString(36).substr(2, 9),
           filename: file.name,
           dataUrl,
           mimeType: file.type,
           regions: [],
           paintStrokes: [],
           status: "idle",
           width: dimensions.width,
           height: dimensions.height
       });
    }
    setImages(prev => [...prev, ...newImages]);
    if (appendImagesInputRef.current) appendImagesInputRef.current.value = '';
  };

  const moveImageUp = (index: number) => {
    if (index === 0) return;
    const newImages = [...images];
    [newImages[index - 1], newImages[index]] = [newImages[index], newImages[index - 1]];
    setImages(newImages);
  };

  const moveImageDown = (index: number) => {
    if (index === images.length - 1) return;
    const newImages = [...images];
    [newImages[index + 1], newImages[index]] = [newImages[index], newImages[index + 1]];
    setImages(newImages);
  };

  const deleteImage = (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setImages(prev => prev.filter(img => img.id !== id));
    if (selectedImageId === id) setSelectedImageId(null);
  };

  const handleFormatLines = (shape: 'diamond' | 'square') => {
    if (!selectedImageId || !selectedRegionId) return;
    const img = images.find(img => img.id === selectedImageId);
    if (!img) return;
    const region = img.regions.find(r => r.id === selectedRegionId);
    if (!region || !region.translatedText) return;

    saveHistory(img.id);
    const lines = region.translatedText.split('\n').map(l => l.replace(/ـ/g, '').trim());
    if (lines.length < 2) return;

    let formatted = [];
    const n = lines.length;
    
    if (shape === 'diamond') {
       const isEven = n % 2 === 0;
       const mid1 = isEven ? (n / 2) - 1 : Math.floor(n / 2);
       const mid2 = isEven ? n / 2 : Math.floor(n / 2);
       
       for (let i = 0; i < n; i++) {
          const dist = Math.min(Math.abs(i - mid1), Math.abs(i - mid2));
          let tatweelCount = (Math.floor(n/2) - dist) * 2;
          let words = lines[i].split(' ');
          if (tatweelCount > 0 && words.length > 0) {
             const targetWordIdx = Math.floor(words.length / 2);
             words[targetWordIdx] += 'ـ'.repeat(tatweelCount);
          }
          formatted.push(words.join(' '));
       }
    } else {
       for (let i = 0; i < n; i++) {
          formatted.push(lines[i]);
       }
    }

    updateRegion(region.id, { translatedText: formatted.join('\n'), textAlign: 'center' });
  };

  const handleSplitBubble = () => {
    if (!selectedImageId || !selectedRegionId) return;
    const img = images.find(img => img.id === selectedImageId);
    if (!img) return;
    const region = img.regions.find(r => r.id === selectedRegionId);
    if (!region) return;

    saveHistory(img.id);
    const region1 = { ...region, h: Math.max(10, region.h / 2), id: 'r_' + Date.now().toString() };
    const region2 = { ...region, y: region.y + region.h / 2, h: Math.max(10, region.h / 2), id: 'r_' + (Date.now() + 1).toString() };

    updateImage(img.id, {
       regions: [...img.regions.filter(r => r.id !== region.id), region1, region2]
    });
    setSelectedRegionId(region1.id);
  };

  const handleExportZip = async () => {
    if (images.length === 0) return;
    setExportProgress('Preparing images for highest quality export...');
    try {
      await downloadProcessedZip(images, (msg) => setExportProgress(msg));
    } catch (err) {
      console.error(err);
      alert("Failed to export ZIP");
    } finally {
      setExportProgress(null);
    }
  };

  const handleExportPsd = async () => {
    if (images.length === 0) return;
    Swal.fire({
      title: 'تصدير PSD',
      text: 'جاري تجهيز وبناء ملف PSD للترجمة الحالية...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    try {
      const imgToExport = images.find(img => img.id === selectedImageId) || images[0];
      
      const imgWrap = new Image();
      imgWrap.crossOrigin = "Anonymous";
      await new Promise((resolve, reject) => {
        imgWrap.onload = resolve;
        imgWrap.onerror = reject;
        imgWrap.src = imgToExport.dataUrl;
      });

      const canvas = document.createElement('canvas');
      canvas.width = imgWrap.width;
      canvas.height = imgWrap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(imgWrap, 0, 0);

      const psd = {
        width: imgWrap.width,
        height: imgWrap.height,
        children: [
          {
            name: 'Original Image',
            canvas: canvas
          }
        ]
      } as any;

      // Add text/regions as layers
      for (const region of imgToExport.regions) {
        if (!region.translatedText) continue;
        
        const regionCanvas = document.createElement('canvas');
        regionCanvas.width = imgWrap.width;
        regionCanvas.height = imgWrap.height;
        const rctx = regionCanvas.getContext('2d');
        if (rctx) {
           rctx.font = `${region.fontStyle} ${region.fontWeight} ${region.fontSize}px "${region.fontFamily}"`;
           rctx.fillStyle = region.textColor;
           rctx.textAlign = region.textAlign as CanvasTextAlign;
           
           const lines = region.translatedText.split('\n');
           const lineHeight = region.fontSize * 1.5;
           const totalHeight = lines.length * lineHeight;
           let startY = region.y + (region.h - totalHeight) / 2 + region.fontSize;
           let startX = region.x + region.w / 2;
           if (region.textAlign === 'right') startX = region.x + region.w;
           if (region.textAlign === 'left') startX = region.x;

           lines.forEach((line) => {
             rctx.fillText(line, startX, startY);
             startY += lineHeight;
           });
        }
        
        psd.children.push({
           name: `Text - ${region.translatedText.substring(0, 10).replace(/(\r\n|\n|\r)/gm, "")}`,
           canvas: regionCanvas
        });
      }

      const buffer = writePsd(psd);
      const blob = new Blob([buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `translated_${imgToExport.id}.psd`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      
      Swal.close();
    } catch (e) {
      console.error(e);
      Swal.fire('Error', 'فشل تصدير مستند الـ PSD', 'error');
    }
  };

  const handleExportPdf = async () => {
    if (images.length === 0) return;
    setExportProgress('Preparing PDF export...');
    try {
      await downloadPdf(images, (msg) => setExportProgress(msg));
    } catch (err) {
      console.error(err);
      alert("Failed to export PDF");
    } finally {
      setExportProgress(null);
    }
  };

  const importTranslationRef = useRef<HTMLInputElement>(null);

  const handleExportTranslation = () => {
    if (images.length === 0) return;
    const docText = createTranslationDoc(images);
    const blob = new Blob([docText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Translation_Doc.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportTranslation = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const newImages = parseTranslationDoc(text, images);
        setImages(newImages);
        alert("Translation imported successfully!");
      } catch (err) {
        console.error(err);
        alert("Failed to parse translation file. Ensure the file has not been corrupted and metadata is intact.");
      }
    };
    reader.readAsText(file);
  };

  const handleImportFonts = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    const loadFont = async (name: string, buffer: ArrayBuffer) => {
      try {
        const fontName = name.replace(/\.[^/.]+$/, "");
        const font = new FontFace(fontName, buffer);
        await font.load();
        document.fonts.add(font);
        setCustomFonts(prev => [...prev, { name: fontName, family: fontName }]);
        return true;
      } catch (err) {
        console.error("Failed to load font", name, err);
        return false;
      }
    };

    let count = 0;
    Swal.fire({
      title: 'استيراد الخطوط',
      text: 'جاري قراءة واستخراج ملفات الخطوط...',
      allowOutsideClick: false,
      didOpen: () => Swal.showLoading()
    });

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.name.toLowerCase().endsWith('.zip')) {
          const zip = new JSZip();
          const contents = await zip.loadAsync(file);
          for (const [filename, fileData] of Object.entries(contents.files)) {
            if (!fileData.dir && (filename.toLowerCase().endsWith('.ttf') || filename.toLowerCase().endsWith('.otf') || filename.toLowerCase().endsWith('.woff'))) {
              const buffer = await fileData.async('arraybuffer');
              if (await loadFont(filename.split('/').pop() || filename, buffer)) count++;
            }
          }
        } else if (file.name.toLowerCase().endsWith('.ttf') || file.name.toLowerCase().endsWith('.otf') || file.name.toLowerCase().endsWith('.woff')) {
          const buffer = await file.arrayBuffer();
          if (await loadFont(file.name, buffer)) count++;
        }
      }
      
      Swal.close();
      if (count > 0) {
        Swal.fire({
          icon: 'success',
          text: `تم استيراد ${count} خط(وط) بنجاح!`,
          confirmButtonColor: '#7c3aed',
          background: '#120b24',
          color: '#f8fafc'
        });
      } else {
         Swal.fire('Error', 'لم يتم العثور على خطوط في الملفات المحددة.', 'warning');
      }
    } catch(err) {
       console.error("Failed to extract fonts", err);
       Swal.fire('Error', 'حدث خطأ أثناء استخراج الخطوط.', 'error');
    }
    
    if (importFontRef.current) {
      importFontRef.current.value = '';
    }
  };

  const handleImportAiScript = async () => {
    const { value: jsonData } = await Swal.fire({
      title: 'استيراد سكربت الذكاء الاصطناعي',
      input: 'textarea',
      inputLabel: 'قم بلصق محتوى JSON المستخرج من AI',
      inputPlaceholder: '{"image_id": {"region_id": "Text"}}',
      inputAttributes: {
        'aria-label': 'Paste AI script JSON here'
      },
      showCancelButton: true,
      confirmButtonText: 'استيراد',
      cancelButtonText: 'إلغاء',
      background: '#120b24',
      color: '#f8fafc',
      confirmButtonColor: '#7c3aed'
    });

    if (jsonData) {
      try {
        const parsed = JSON.parse(jsonData);
        let updatedCount = 0;
        setImages(prev => prev.map(img => {
          // It could be purely sequential or keyed by ID. We try both.
          const updatesForImg = parsed[img.id] || parsed[img.file.name] || Object.values(parsed)[0]; // Fallback if single image script
          if (!updatesForImg) return img;
          
          let regionIdx = 0;
          const newRegions = img.regions.map(r => {
             const val = updatesForImg[r.id] || Object.values(updatesForImg)[regionIdx];
             regionIdx++;
             if (val && typeof val === 'string') {
               updatedCount++;
               return { ...r, translatedText: val };
             }
             return r;
          });
          return { ...img, regions: newRegions };
        }));
        
        Swal.fire({
          icon: 'success',
          text: `تم استيراد ${updatedCount} ترجمة من السكربت بنجاح.`,
          background: '#120b24',
          color: '#f8fafc',
          confirmButtonColor: '#7c3aed'
        });
      } catch(err) {
        Swal.fire('Error', 'خطأ في قراءة نص JSON. يرجى التأكد من الصيغة الصحيحة.', 'error');
      }
    }
  };

  const handleDownloadCurrentPage = async () => {
    const imgToDownload = selectedImage || images[0];
    if (!imgToDownload) return;
    setExportProgress('Rendering image...');
    try {
      await downloadSingleImage(imgToDownload);
    } catch (err) {
      console.error(err);
      alert("Failed to download image");
    } finally {
      setExportProgress(null);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gradient-to-tr from-black via-[#0d091a] to-black text-slate-200 overflow-hidden font-sans">
      {exportProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm">
          <div className="liquid-glass rounded-3xl p-8 flex flex-col items-center gap-4 max-w-md w-full shadow-[0_20px_50px_rgba(168,85,247,0.35)] border border-purple-500/35 animate-fade-in">
            <Loader2 size={48} className="animate-spin text-purple-400" />
            <h2 className="text-xl font-display font-bold text-white tracking-tight">Exporting High Quality ZIP</h2>
            <p className="text-sm text-slate-400 text-center font-mono">{exportProgress}</p>
          </div>
        </div>
      )}
      {/* Topbar */}
      {activeNavigationTab === 'library' && activeChapterId !== null && (
        <header className="h-16 border-b border-purple-500/10 flex items-center justify-between px-6 bg-black/40 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-6">
            <button
              onClick={() => {
                setActiveChapterId(null);
                setImages([]);
                setSelectedImageId(null);
              }}
              className="flex items-center gap-2 bg-purple-950/45 hover:bg-purple-900 border border-purple-500/35 text-purple-300 hover:text-white px-3 py-1.5 rounded-lg text-xs font-semibold font-display transition-all"
            >
              ← رجوع للمكتبة (Library)
            </button>
            <div className="flex items-center gap-3">
              <img src="https://i.ibb.co/sJvJXWB2/1778522654517.png" alt="MET Logo" className="h-8 object-contain" />
              <h1 className="font-display font-bold text-xl tracking-tight text-white leading-none hidden sm:block">MET</h1>
            </div>
            
            <div className="relative">
             <button 
               onClick={() => setShowSettingsModal(true)}
               className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${customApiKey ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400' : 'bg-[#111] border-[#444] text-slate-300'}`}
             >
               <Settings size={14} />
               Settings
             </button>
          </div>
        </div>
        
        {showSettingsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-md p-4 text-left">
          <div className="liquid-glass rounded-3xl w-full max-w-md shadow-[0_20px_50px_rgba(168,85,247,0.3)] border border-purple-500/25 flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-5 border-b border-purple-500/10">
              <h2 className="text-lg font-display font-bold text-white flex items-center gap-2">
                <span className="text-purple-400">✧</span> Application Settings
              </h2>
              <button 
                onClick={() => setShowSettingsModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-md transition-colors"
              >
                ✕
              </button>
            </div>
            
            <div className="p-5 overflow-y-auto flex flex-col gap-6">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-slate-300 font-display">
                    Gemini API Keys (One per line)
                  </span>
                  {customApiKey.split(/[\s,\n]+/).map(k => k.trim()).filter(Boolean).length > 0 && (
                    <span className="text-[11px] bg-purple-950/40 border border-purple-800 text-purple-400 px-2 py-0.5 rounded-full font-mono">
                      {customApiKey.split(/[\s,\n]+/).map(k => k.trim()).filter(Boolean).length} Keys
                    </span>
                  )}
                </div>
                <textarea 
                  value={customApiKey}
                  onChange={handleApiKeyChange}
                  placeholder="Enter your Gemini API key(s)..."
                  className="w-full h-24 bg-black/60 border border-purple-500/15 rounded-md p-2 text-xs outline-none focus:border-purple-500 font-mono text-slate-200 resize-none"
                />
                <div className="space-y-1 text-[10px] text-slate-500 leading-relaxed font-mono">
                  <p>✔ Enter multiple API keys to enable concurrent parallel translation across multiple page streams.</p>
                  <p>✔ Keeps rate limits healthy by routing requests across keys dynamically.</p>
                  <p>✔ External usage outside of the AI Studio preview environment requires a valid personal Gemini API Key.</p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="flex flex-col text-sm font-medium text-slate-300">
                  Cleaned ZIP Match Mode
                  <select 
                    value={zipMatchMode}
                    onChange={(e) => handleSetZipMatchMode(e.target.value as 'filename' | 'index')}
                    className="w-full bg-black border border-[#444] rounded-md p-2 mt-1 text-sm outline-none focus:border-indigo-500 font-normal text-slate-200"
                  >
                    <option value="filename">Match by Filename (Recommended)</option>
                    <option value="index">Match by Order (Index)</option>
                  </select>
                </label>
                <p className="text-[10px] text-slate-500">How to map uploaded cleaned images to the original ones.</p>
              </div>

              <div className="space-y-2">
                <label className="flex flex-col text-sm font-medium text-slate-300">
                  Custom AI Instructions
                  <textarea 
                    value={customInstructions}
                    onChange={handleCustomInstructionsChange}
                    placeholder="E.g., Translate the text specifically using Egyptian dialect."
                    className="w-full bg-black border border-[#444] rounded-md p-2 mt-1 text-sm outline-none focus:border-indigo-500 font-normal h-20 resize-y"
                  />
                </label>
                <p className="text-[10px] text-slate-500">Custom instructions supplied to the translation agent.</p>
              </div>

              <div className="flex flex-col gap-4">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={translateJapanese} 
                    onChange={(e) => handleSetTranslateJapanese(e.target.checked)}
                    className="w-4 h-4 rounded border-[#444] bg-black text-indigo-600 focus:ring-indigo-500 focus:ring-offset-black"
                  />
                  <span className="text-sm font-medium text-slate-300">Translate text from Japanese</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={translateSfx} 
                    onChange={(e) => handleSetTranslateSfx(e.target.checked)}
                    className="w-4 h-4 rounded border-[#444] bg-black text-indigo-600 focus:ring-indigo-500 focus:ring-offset-black"
                  />
                  <span className="text-sm font-medium text-slate-300">Analyze and translate SFX</span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer border-t border-slate-800/60 pt-3">
                  <input 
                    type="checkbox" 
                    checked={autoFitAndCenter} 
                    onChange={(e) => handleSetAutoFitAndCenter(e.target.checked)}
                    className="w-4 h-4 rounded border-[#444] bg-black text-indigo-600 focus:ring-indigo-500 focus:ring-offset-black"
                  />
                  <span className="text-sm font-medium text-slate-300 flex flex-col">
                    <span>Auto Flood Fill & Alignment</span>
                    <span className="text-[10px] text-slate-500 font-normal">Automatically align text and expand bounds to fit speech bubbles safely</span>
                  </span>
                </label>

                <label className="flex items-center gap-3 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={compressBeforeProcessing} 
                    onChange={(e) => handleSetCompressBeforeProcessing(e.target.checked)}
                    className="w-4 h-4 rounded border-[#444] bg-[#111] text-indigo-600 focus:ring-indigo-500 focus:ring-offset-black"
                  />
                  <span className="text-sm font-medium text-slate-300 flex flex-col">
                    <span>Compress Large Images</span>
                    <span className="text-[10px] text-slate-500 font-normal">Pre-compress page images to boost Gemini AI analytical processing speeds</span>
                  </span>
                </label>
              </div>
            </div>

            <div className="p-4 border-t border-[#333] flex justify-end">
              <button 
                onClick={() => setShowSettingsModal(false)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer"
              >
                Close Settings
              </button>
            </div>
          </div>
        </div>
      )}
      
        <div className="flex items-center gap-4 z-10">
           <div className="flex bg-[#111] rounded-md p-1">
            <input 
              type="file" 
              accept=".zip" 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleZipUpload}
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 hover:bg-[#222] px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
              title="Import ZIP"
            >
              <Upload size={16} /> Import ZIP
            </button>

            <div className="w-px bg-slate-700 mx-1 my-1"></div>

            <input 
              type="file" 
              accept=".zip" 
              className="hidden" 
              ref={cleanZipInputRef}
              onChange={handleCleanedZipUpload}
            />
            <button 
              onClick={() => cleanZipInputRef.current?.click()}
              className="flex items-center gap-2 hover:bg-[#222] px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
              title="Upload Cleaned ZIP"
            >
              <Sparkles size={16} /> Cleaned ZIP
            </button>

            <div className="w-px bg-slate-700 mx-1 my-1"></div>

            <input 
              type="file" 
              accept="image/*"
              multiple
              className="hidden" 
              ref={appendImagesInputRef}
              onChange={handleAppendImages}
            />
            <button 
              onClick={() => appendImagesInputRef.current?.click()}
              className="flex items-center gap-2 hover:bg-[#222] px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
              title="Add Images"
            >
              <ImagePlus size={16} /> Add Images
            </button>

            <div className="w-px bg-slate-700 mx-1 my-1"></div>

            <input 
              type="file" 
              accept=".json" 
              className="hidden" 
              ref={projectInputRef}
              onChange={handleLoadProject}
            />
            <button 
              onClick={() => projectInputRef.current?.click()}
              className="flex items-center gap-1.5 hover:bg-[#222] px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
              title="Load Project"
            >
              Load State
            </button>
            <button 
              onClick={handleSaveProject}
              disabled={images.length === 0}
              className="flex items-center gap-1.5 hover:bg-[#222] disabled:opacity-50 px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
              title="Save Project"
            >
              <Save size={16} /> Save State
            </button>
          </div>
          
          <button 
            onClick={processAllImages}
            disabled={images.length === 0 || isProcessingAll}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/50 disabled:cursor-not-allowed px-4 py-2 rounded-md font-medium text-sm transition-colors"
          >
            {isProcessingAll ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Process All
          </button>
          
          <button 
            onClick={() => setShowOriginal(!showOriginal)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm transition-colors border ${showOriginal ? 'bg-amber-600 border-amber-600 text-white' : 'bg-[#111] border-[#444] text-slate-300 hover:bg-[#222]'}`}
          >
            {showOriginal ? 'Showing Original' : 'View Original'}
          </button>
          
          <button 
            onClick={() => setShowText(!showText)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm transition-colors border ${!showText ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-[#111] border-[#444] text-slate-300 hover:bg-[#222]'}`}
          >
            <TypeIcon size={16} />
            {showText ? 'Hide Texts' : 'Show Texts'}
          </button>
          
          <div className="flex bg-emerald-700/50 rounded-md overflow-hidden border border-emerald-600/30">
            <button 
              onClick={handleExportZip}
              disabled={images.length === 0}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed px-4 py-2 font-medium text-sm text-white transition-colors border-r border-emerald-500/20"
              title="Export as ZIP archive"
            >
              <Download size={16} /> ZIP
            </button>
            <button 
              onClick={handleExportPdf}
              disabled={images.length === 0}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed px-4 py-2 font-medium text-sm text-white transition-colors border-r border-emerald-500/20"
              title="Export as paginated PDF"
            >
              PDF
            </button>
            <button 
              onClick={handleExportPsd}
              disabled={images.length === 0}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed px-4 py-2 font-medium text-sm text-white transition-colors border-r border-emerald-500/20"
              title="Export current page as PSD"
            >
              PSD
            </button>
            <button 
              onClick={handleExportTranslation}
              disabled={images.length === 0}
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:bg-[#111] disabled:cursor-not-allowed px-4 py-2 font-medium text-sm text-white transition-colors border-r border-slate-600"
              title="Export text document for external translation"
            >
              Export Docs
            </button>
            <button 
              onClick={() => importTranslationRef.current?.click()}
              disabled={images.length === 0}
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:bg-[#111] disabled:cursor-not-allowed px-4 py-2 font-medium text-sm text-white transition-colors border-r border-slate-600"
              title="Import translated text document"
            >
              Import Docs
            </button>
            <button 
              onClick={handleImportAiScript}
              disabled={images.length === 0}
              className="flex items-center gap-2 bg-purple-700 hover:bg-purple-600 disabled:bg-[#111] disabled:cursor-not-allowed px-4 py-2 font-medium text-sm text-white transition-colors"
              title="Import JSON from external AI model (Claude/Gemini)"
            >
              استيراد سكربت الذكاء الاصطناعي
            </button>
            <input 
              type="file" 
              ref={importTranslationRef} 
              onChange={handleImportTranslation} 
              accept=".txt" 
              className="hidden" 
            />
          </div>
        </div>
      </header>
      )}

      {/* Main Content */}
      <div className="flex flex-col lg:flex-row flex-1 overflow-hidden">
        {activeNavigationTab === 'settings' && (
          <div className="flex-1 flex flex-col p-8 bg-gradient-to-tr from-[#03010c] via-[#0b0718] to-black relative overflow-y-auto pb-32">
            <div className="absolute top-10 right-10 w-96 h-96 bg-purple-600/5 rounded-full blur-[140px] pointer-events-none" />
            <div className="max-w-5xl mx-auto w-full flex flex-col gap-8 relative z-10">
              <div>
                <h1 className="text-3xl font-display font-bold text-white tracking-tight">Studio Configuration Settings</h1>
                <p className="text-sm text-slate-400 mt-1">Fine-tune translation thresholds, OCR dialects, parallel execution caches, and Gemini API keys.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {/* Left Config Panel */}
                <div className="md:col-span-2 space-y-6">
                  {/* API Key Box */}
                  <div className="liquid-glass p-6 rounded-2xl border border-purple-500/15 space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-base font-semibold text-white font-display">Gemini API Credentials</h3>
                      {customApiKey.split(/[\s,\n]+/).map(k => k.trim()).filter(Boolean).length > 0 && (
                        <span className="text-[11px] bg-purple-950/40 border border-purple-800 text-purple-400 px-2.5 py-0.5 rounded-full font-mono">
                          {customApiKey.split(/[\s,\n]+/).map(k => k.trim()).filter(Boolean).length} Key(s) Loaded
                        </span>
                      )}
                    </div>
                    <textarea 
                      value={customApiKey}
                      onChange={handleApiKeyChange}
                      placeholder="Add keys (one key per line or comma-separated)..."
                      className="w-full h-28 bg-black/60 border border-purple-500/15 rounded-xl p-3 text-sm outline-none focus:border-purple-500 text-slate-200 resize-none font-mono focus:ring-1 focus:ring-purple-500/20"
                    />
                    <div className="space-y-1.5 text-[11px] text-slate-400 leading-relaxed font-mono">
                      <p>✧ Speed tip: Rotating several keys shares requests seamlessly to avoid rate limits safely.</p>
                      <p>✧ Runs automatically on standard Gemini flash parameters to ensure prompt translations.</p>
                    </div>
                  </div>

                  {/* Instructions Box */}
                  <div className="liquid-glass p-6 rounded-2xl border border-purple-500/15 space-y-4">
                    <h3 className="text-base font-semibold text-white font-display">Custom Agent Prompting</h3>
                    <textarea 
                      value={customInstructions}
                      onChange={handleCustomInstructionsChange}
                      placeholder="E.g., Translate to Egyptian dialect, keep humor puns, keep sound effects minimal, etc."
                      className="w-full h-28 bg-black/60 border border-purple-500/15 rounded-xl p-3 text-sm outline-none focus:border-purple-500 text-slate-200 resize-none font-sans focus:ring-1 focus:ring-purple-500/20"
                    />
                    <p className="text-[11px] text-slate-400 font-mono">
                      ✧ Custom instructions are passed directly to the Gemini neural vision matrix during page synthesis.
                    </p>
                  </div>
                </div>

                {/* Right Toggle Rules */}
                <div className="space-y-6">
                  <div className="liquid-glass p-6 rounded-2xl border border-purple-500/15 space-y-5">
                    <h3 className="text-base font-semibold text-white font-display">Optimization Rules</h3>
                    
                    <div className="space-y-4">
                      {/* Checkboxes */}
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          checked={translateJapanese} 
                          onChange={(e) => handleSetTranslateJapanese(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded border-purple-500/20 bg-black text-purple-600 focus:ring-purple-500"
                        />
                        <span className="flex flex-col">
                          <span className="text-sm font-semibold text-slate-200 group-hover:text-purple-300 transition-colors">Translate Japanese Content</span>
                          <span className="text-[10px] text-slate-500 mt-0.5">Optimizes neural model parameters for Japanese language OCR streams.</span>
                        </span>
                      </label>

                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          checked={translateSfx} 
                          onChange={(e) => handleSetTranslateSfx(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded border-purple-500/20 bg-black text-purple-600 focus:ring-purple-500"
                        />
                        <span className="flex flex-col">
                          <span className="text-sm font-semibold text-slate-200 group-hover:text-purple-300 transition-colors">Translate Comic SFX</span>
                          <span className="text-[10px] text-slate-500 mt-0.5">Translate small action sound effects alongside text blocks.</span>
                        </span>
                      </label>

                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          checked={autoFitAndCenter} 
                          onChange={(e) => handleSetAutoFitAndCenter(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded border-purple-500/20 bg-black text-purple-600 focus:ring-purple-500"
                        />
                        <span className="flex flex-col">
                          <span className="text-sm font-semibold text-slate-200 group-hover:text-purple-300 transition-colors">Auto Bubble Fit & Center</span>
                          <span className="text-[10px] text-slate-500 mt-0.5">Automatically calculates text bounds to match speech balloon radii.</span>
                        </span>
                      </label>

                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          checked={compressBeforeProcessing} 
                          onChange={(e) => handleSetCompressBeforeProcessing(e.target.checked)}
                          className="w-4 h-4 mt-0.5 rounded border-purple-500/20 bg-black text-purple-600 focus:ring-purple-500"
                        />
                        <span className="flex flex-col">
                          <span className="text-sm font-semibold text-slate-200 group-hover:text-purple-300 transition-colors">Pre-Compress Plate Images</span>
                          <span className="text-[10px] text-slate-500 mt-0.5">Reduces page sizes to achieve 3.5x faster analytical cycle times.</span>
                        </span>
                      </label>
                    </div>
                  </div>

                  <div className="liquid-glass p-6 rounded-2xl border border-purple-500/15 space-y-3">
                    <h4 className="text-sm font-semibold text-slate-200">Plates Mapping Mode</h4>
                    <select 
                      value={zipMatchMode}
                      onChange={(e) => handleSetZipMatchMode(e.target.value as 'filename' | 'index')}
                      className="w-full bg-black/60 border border-purple-500/15 rounded-xl p-2.5 text-xs text-slate-300 focus:border-purple-500 focus:ring-1 focus:ring-purple-500/20 outline-none"
                    >
                      <option value="filename">Match by Filename (Recommended)</option>
                      <option value="index">Match by Order Index</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeNavigationTab === 'cloud' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-gradient-to-tr from-[#03010c] via-[#0b0718] to-black relative overflow-y-auto pb-32">
            <Settings size={64} className="text-purple-500/50 animate-spin mb-6" />
            <h1 className="text-3xl font-display font-bold text-white tracking-tight">قيد التطوير</h1>
            <p className="text-sm text-slate-400 mt-2">ميزة التخزين السحابي قيد التطوير والمراجعة حالياً، يرجى الانتظار.</p>
          </div>
        )}

        {activeNavigationTab === 'scheduler' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-gradient-to-tr from-[#03010c] via-[#0b0718] to-black relative overflow-y-auto pb-32">
            <Settings size={64} className="text-purple-500/50 animate-spin mb-6" />
            <h1 className="text-3xl font-display font-bold text-white tracking-tight">قيد التطوير</h1>
            <p className="text-sm text-slate-400 mt-2">نظام الجدولة قيد التطوير حالياً، يرجى العودة لاحقاً.</p>
          </div>
        )}

        {activeNavigationTab === 'library' && activeChapterId === null && (
          <div className="flex-1 flex flex-col p-8 bg-gradient-to-tr from-[#03010c] via-[#090615] to-black relative overflow-y-auto pb-32">
            <div className="absolute top-10 right-10 w-96 h-96 bg-purple-600/5 rounded-full blur-[140px] pointer-events-none" />
            <div className="absolute bottom-10 left-10 w-96 h-96 bg-indigo-650/5 rounded-full blur-[140px] pointer-events-none" />

            <div className="max-w-6xl mx-auto w-full flex flex-col gap-8 relative z-10">
              
              {/* BREADCRUMBS & ACTION HEADER */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-purple-500/10 pb-6">
                <div>
                  <div className="flex items-center gap-2 text-xs font-mono text-purple-350 mb-2">
                    <span className="font-semibold select-none">المكتبة (Library)</span>
                    {activeMangaId && (
                      <>
                        <span>/</span>
                        <button 
                          onClick={() => { setActiveMangaId(null); setActiveVolumeId(null); }}
                          className="hover:text-white transition-all underline decoration-purple-500/50"
                        >
                          {mangas.find(m => m.id === activeMangaId)?.title}
                        </button>
                      </>
                    )}
                    {activeVolumeId && (
                      <>
                        <span>/</span>
                        <button 
                          onClick={() => setActiveVolumeId(null)}
                          className="hover:text-white transition-all underline decoration-purple-500/50"
                        >
                          {mangas.find(m => m.id === activeMangaId)?.volumes.find(v => v.id === activeVolumeId)?.name}
                        </button>
                      </>
                    )}
                  </div>
                  
                  <h1 className="text-3xl font-display font-bold text-white tracking-tight">
                    {!activeMangaId 
                      ? 'قسم مكتبتي - السلاسل (Series Library)' 
                      : !activeVolumeId 
                        ? 'إدارة المجلدات (Volumes List)' 
                        : 'فصول الترجمة (Chapter Workspace)'}
                  </h1>
                  <p className="text-xs text-slate-400 mt-1.5 font-sans leading-relaxed">
                    {!activeMangaId 
                      ? 'تصفح قصص المانجا والمانهوا الحالية، أو أنشئ سلسلة ترجمة جديدة بضغطة زر.' 
                      : !activeVolumeId 
                        ? 'اختر مجلداً محدداً لتقسيم وإدارة فصول الترجمة التابعة له.' 
                        : 'افتح فصل الترجمة للدخول إلى الاستوديو وبدء المسح الآلي وملاءمة الفقاعات وسحب النتائج.'}
                  </p>
                </div>

                <div className="flex items-center gap-2.5">
                  {!activeMangaId && (
                    <>
                      <button 
                        onClick={loadDemoProject}
                        className="bg-black/60 hover:bg-black border border-purple-500/25 text-purple-300 font-bold py-2.5 px-5 rounded-xl transition-all cursor-pointer text-xs"
                      >
                        ⚡ تحميل عينة مانهوا (Load Demo)
                      </button>
                      <button 
                        onClick={() => setShowCreateSeriesModal(true)}
                        className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold py-2.5 px-5 rounded-xl transition-all cursor-pointer text-xs shadow-md"
                      >
                        + إنشاء مانجا جديدة (New Manga)
                      </button>
                    </>
                  )}
                  {activeMangaId && !activeVolumeId && (
                    <>
                      <button 
                        onClick={() => { setActiveMangaId(null); }}
                        className="bg-black/60 border border-purple-500/15 hover:border-purple-500/40 text-slate-350 font-bold py-2.5 px-4 rounded-xl transition-all text-xs"
                      >
                        ← رجوع للكل (Back)
                      </button>
                      <button 
                        onClick={handleAddVolumePrompt}
                        className="bg-purple-600 hover:bg-purple-550 text-white font-bold py-2.5 px-5 rounded-xl transition-all text-xs cursor-pointer shadow-md shadow-purple-950/45"
                      >
                        + إضافة مجلد جديد (Add Volume)
                      </button>
                    </>
                  )}
                  {activeMangaId && activeVolumeId && (
                    <>
                      <button 
                        onClick={() => { setActiveVolumeId(null); }}
                        className="bg-black/60 border border-purple-500/15 hover:border-purple-500/40 text-slate-350 font-bold py-2.5 px-4 rounded-xl transition-all text-xs"
                      >
                        ← المجلدات (Volumes)
                      </button>
                      <button 
                        onClick={handleAddChapterPrompt}
                        className="bg-indigo-600 hover:bg-indigo-550 text-white font-bold py-2.5 px-5 rounded-xl transition-all text-xs cursor-pointer shadow-md shadow-indigo-950/45"
                      >
                        + إضافة شابتر جديد (Add Chapter)
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* STATE A: MANGA SERIES GRID */}
              {!activeMangaId && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                  {mangas.length === 0 ? (
                    <div className="col-span-full py-16 text-center">
                      <div className="w-16 h-16 bg-purple-950/20 border border-purple-500/20 rounded-2xl flex items-center justify-center text-purple-400 mx-auto mb-4">
                        <ImageIcon size={28} />
                      </div>
                      <h3 className="text-lg font-bold text-slate-200">لا توجد سلاسل مانجا حالياً</h3>
                      <p className="text-xs text-slate-400 max-w-sm mx-auto mt-2 leading-relaxed font-sans">
                        قم بالبدء بإنشاء سلسلة مانجا/مانهوا جديدة لتسجيل فصولها وترجمتها بشكل منظم، أو اضغط زر "تحميل عينة مانهوا" للحصول على مانهوا سولو ليفنج تجريبية.
                      </p>
                      <button
                        onClick={() => setShowCreateSeriesModal(true)}
                        className="mt-5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-bold text-xs py-2.5 px-6 rounded-xl transition-all"
                      >
                        + إنشاء مانجا جديدة للبدء (Create New)
                      </button>
                    </div>
                  ) : (
                    mangas.map(manga => {
                      const totalChaptersCount = manga.volumes.reduce((acc, v) => acc + v.chapters.length, 0);
                      return (
                        <div 
                          key={manga.id}
                          onClick={() => setActiveMangaId(manga.id)}
                          className="relative aspect-[3/4] rounded-2xl overflow-hidden group shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-purple-500/10 hover:border-purple-500/35 transition-all duration-300 cursor-pointer flex flex-col justify-end bg-[#05020c]"
                        >
                          {/* Cover Image/Gradient Representation */}
                          {manga.coverUrl ? (
                            <img 
                              src={manga.coverUrl} 
                              alt={manga.title} 
                              referrerPolicy="no-referrer"
                              className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 opacity-60"
                            />
                          ) : (
                            <div className="absolute inset-0 bg-gradient-to-tr from-[#120731] via-[#09041a] to-black flex flex-col items-center justify-center p-6 text-center">
                              <Sparkles className="w-10 h-10 text-purple-500/60 animate-pulse mb-3" />
                              <span className="text-xs text-purple-400/85 tracking-widest uppercase font-mono font-bold leading-none">{manga.type}</span>
                            </div>
                          )}
                          
                          {/* Type Badge top-left */}
                          <span className={`absolute top-4 left-4 text-[9px] font-bold px-2.5 py-1 rounded-md uppercase tracking-wider z-20 ${manga.type === 'manhwa' ? 'bg-indigo-600 border border-indigo-400 text-white' : 'bg-amber-600 border border-amber-400 text-white'}`}>
                            {manga.type}
                          </span>

                          {/* Quick Delete top-right */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteManga(manga.id);
                            }}
                            className="absolute top-4 right-4 bg-red-950/80 hover:bg-red-700 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-all z-20 shadow-md border border-red-500/20"
                            title="حذف السلسلة من المكتبة"
                          >
                            <Trash2 size={13} />
                          </button>

                          {/* Lower Liquid Glass layer - overlay cover bottom */}
                          <div className="absolute bottom-0 left-0 right-0 p-4 bg-black/60 backdrop-blur-md border-t border-purple-500/15 flex flex-col gap-1 transition-all group-hover:bg-[#110729]/85 z-10 text-left">
                            <span className="text-[10px] text-purple-400 tracking-wider uppercase font-mono font-bold">{manga.type}</span>
                            <h3 className="text-base font-display font-bold text-white tracking-tight truncate leading-tight">{manga.title}</h3>
                            <p className="text-[11px] text-slate-350 leading-normal line-clamp-2 h-8 font-sans">{manga.description || 'لم يتم كتابة وصف مخصص لهذه السلسلة بعد.'}</p>
                            <div className="flex items-center justify-between text-[10px] text-purple-300 font-mono mt-1 w-full pt-2 border-t border-purple-500/10">
                              <span>📚 المجلدات: {manga.volumes.length}</span>
                              <span>📖 فصول: {totalChaptersCount}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* STATE B: VOLUMES GRID LIST */}
              {activeMangaId && !activeVolumeId && (
                (() => {
                  const currentManga = mangas.find(m => m.id === activeMangaId);
                  if (!currentManga) return null;
                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                      {currentManga.volumes.length === 0 ? (
                        <div className="col-span-full py-16 text-center">
                          <div className="w-16 h-16 bg-purple-950/20 border border-purple-500/20 rounded-2xl flex items-center justify-center text-purple-400 mx-auto mb-4">
                            <Plus size={28} />
                          </div>
                          <h3 className="text-lg font-bold text-slate-200">لا توجد مجلدات حالياً</h3>
                          <p className="text-xs text-slate-400 max-w-sm mx-auto mt-2 leading-relaxed">
                            مجلدات المانجا تستخدم لتنظيم وتقسيم فئات فصول الترجمة الكبيرة (مثال: مجلد 20، مجلد 1).
                          </p>
                          <button
                            onClick={handleAddVolumePrompt}
                            className="mt-5 bg-purple-600 hover:bg-purple-550 text-white font-bold text-xs py-2.5 px-6 rounded-xl transition-all"
                          >
                            + إضافة أول مجلد جديد (Create Volume)
                          </button>
                        </div>
                      ) : (
                        currentManga.volumes.map(vol => (
                          <div 
                            key={vol.id}
                            onClick={() => setActiveVolumeId(vol.id)}
                            className="relative aspect-[3/4] bg-gradient-to-tr from-[#12072f] via-[#09041a] to-black rounded-2xl overflow-hidden border border-purple-500/10 hover:border-purple-500/35 transition-all duration-300 cursor-pointer flex flex-col justify-end p-6 group text-left"
                          >
                            {/* Inherited Cover backdrop or pattern */}
                            {currentManga.coverUrl && (
                              <img 
                                src={currentManga.coverUrl} 
                                alt={vol.name} 
                                className="absolute inset-0 w-full h-full object-cover opacity-15"
                              />
                            )}

                            {/* Vol delete top-right */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteVolume(vol.id);
                              }}
                              className="absolute top-4 right-4 bg-red-950/80 hover:bg-red-700 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-all z-20 shadow-md border border-red-500/20"
                              title="حذف هذا المجلد كلياً"
                            >
                              <Trash2 size={13} />
                            </button>

                            <div className="absolute inset-0 bg-radial-gradient from-transparent to-black pointer-events-none" />

                            {/* Bottom Liquid Glass display inside the Volume Card */}
                            <div className="absolute bottom-0 left-0 right-0 p-5 bg-black/80 backdrop-blur-md border-t border-purple-500/15 flex flex-col gap-1.5 transition-all group-hover:bg-[#110729]/95 z-10 text-left">
                              <span className="text-[10px] text-purple-400 tracking-wider font-mono font-bold">VOLUME CONTAINER</span>
                              <h3 className="text-xl font-display font-bold text-purple-300 tracking-tight leading-none mb-1">{vol.name}</h3>
                              <p className="text-xs text-slate-350 line-clamp-2 h-8 font-sans leading-relaxed text-left">
                                {vol.chapters.length > 0 
                                  ? `يحتوي على: ${vol.chapters.map(c => c.name).join(', ')}` 
                                  : 'مجلد فارغ حالياً، انقر لإضافة فصول ترجمة جديدة بداخل هذا المجلد.'}
                              </p>
                              <div className="flex justify-between items-center text-[10px] text-slate-400 font-mono mt-1 pt-2 border-t border-purple-500/10 w-full">
                                <span>📖 الفصول: {vol.chapters.length} </span>
                                <span className="text-emerald-500 font-bold font-mono">✔ نشط</span>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  );
                })()
              )}

              {/* STATE C: CHAPTER REPOSITORY GRID */}
              {activeMangaId && activeVolumeId && (
                (() => {
                  const currentManga = mangas.find(m => m.id === activeMangaId);
                  const currentVolume = currentManga?.volumes.find(v => v.id === activeVolumeId);
                  if (!currentVolume) return null;
                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                      {currentVolume.chapters.length === 0 ? (
                        <div className="col-span-full py-16 text-center">
                          <div className="w-16 h-16 bg-purple-950/20 border border-purple-500/20 rounded-2xl flex items-center justify-center text-purple-400 mx-auto mb-4">
                            <Plus size={28} />
                          </div>
                          <h3 className="text-lg font-bold text-slate-200">لا توجد فصول حالياً</h3>
                          <p className="text-xs text-slate-400 max-w-sm mx-auto mt-2 leading-relaxed">
                            أنشئ فصولاً لهذا المجلد للبدء فوراً في إرفاق صفحات المانجا وتبييض وملاءمة الفقاعات عبر الاستوديو الأساسي.
                          </p>
                          <button
                            onClick={handleAddChapterPrompt}
                            className="mt-5 bg-indigo-600 hover:bg-indigo-550 text-white font-bold text-xs py-2.5 px-6 rounded-xl transition-all"
                          >
                            + إضافة شابتر جديد للترجمة (Add Chapter)
                          </button>
                        </div>
                      ) : (
                        currentVolume.chapters.map(chap => {
                          const coverPage = chap.images[0]?.dataUrl;
                          return (
                            <div 
                              key={chap.id}
                              onClick={() => handleOpenChapter(chap)}
                              className="relative aspect-[3/4] bg-gradient-to-tr from-[#0b0424] via-[#050212] to-black rounded-2xl overflow-hidden border border-purple-500/10 hover:border-purple-500/35 transition-all duration-300 cursor-pointer flex flex-col justify-end p-6 group text-left"
                            >
                              {coverPage ? (
                                <img 
                                  src={coverPage} 
                                  alt={chap.name} 
                                  className="absolute inset-0 w-full h-full object-cover opacity-45 group-hover:scale-105 transition-all duration-300"
                                />
                              ) : (
                                <div className="absolute inset-0 bg-gradient-to-br from-[#120731] via-black to-[#050214] flex flex-col items-center justify-center p-6 text-center opacity-30">
                                  <svg className="w-12 h-12 text-slate-500 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1}>
                                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                                  </svg>
                                </div>
                              )}

                              {/* Chapter Delete top-right */}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteChapter(chap.id);
                                }}
                                className="absolute top-4 right-4 bg-red-950/85 hover:bg-red-750 text-white p-2 rounded-lg opacity-0 group-hover:opacity-100 transition-all z-20 shadow-md border border-red-500/20"
                                title="حذف هذا الشابتر كلياً"
                              >
                                <Trash2 size={13} />
                              </button>

                              {/* Bottom Liquid Glass display inside the Chapter Card */}
                              <div className="absolute bottom-0 left-0 right-0 p-5 bg-black/85 backdrop-blur-md border-t border-purple-500/15 flex flex-col gap-1 transition-all group-hover:bg-[#120733]/90 z-10 text-left">
                                <span className="text-[10px] text-indigo-400 tracking-wider font-mono font-bold">MANGA CHAPTER</span>
                                <h3 className="text-base font-display font-bold text-white tracking-tight leading-none mb-1">{chap.name}</h3>
                                <p className="text-[11px] text-slate-350 leading-normal line-clamp-1 font-sans">
                                  {chap.images.length > 0 ? `يحتوي على ${chap.images.length} صفحة مجهزة.` : 'شابتر فارغ. انقر للدخول ورفع الصور.'}
                                </p>
                                <div className="flex justify-between items-center text-[10px] text-indigo-300 font-mono mt-1.5 pt-1.5 border-t border-purple-500/10 w-full">
                                  <span>🚀 فتح بالاستوديو</span>
                                  <span>{chap.images.length} Pages</span>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  );
                })()
              )}
            </div>
          </div>
        )}

        {activeNavigationTab === 'library' && activeChapterId !== null && images.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#04020a] relative">
            {/* Ambient spotlights */}
            <div className="absolute top-1/4 left-1/3 w-80 h-80 bg-purple-650/5 rounded-full blur-[140px] pointer-events-none" />
            <div className="absolute bottom-1/4 right-1/3 w-80 h-80 bg-indigo-650/5 rounded-full blur-[140px] pointer-events-none" />
            
            <div className="liquid-glass p-12 rounded-3xl max-w-xl w-full flex flex-col items-center gap-6 shadow-[0_15px_40px_rgba(168,85,247,0.2)] text-slate-200 text-center border border-purple-500/15 relative z-10">
              <div className="w-20 h-20 bg-purple-950/20 rounded-2xl border border-purple-500/25 flex items-center justify-center text-purple-400 shadow-inner">
                <svg className="w-10 h-10 animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              </div>
              <div className="flex flex-col gap-1.5">
                <h3 className="text-2xl font-display font-bold text-white tracking-tight">هذا الفصل فارغ حالياً (Chapter is Empty)</h3>
                <p className="text-sm text-slate-400 max-w-md mt-1 mx-auto leading-relaxed font-sans">
                  قم بإنشاء مساحتك داخل هدا الفصل عن طريق سحب وإسقاط ملف ZIP، أو رفع الصفحات واحدة تلو الأخرى، أو تحميل مشروع تجريبي لتجربته فوراً.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-center gap-3 w-full mt-2">
                <button 
                  onClick={() => setShowCreateProjectModal(true)}
                  className="w-full sm:w-auto flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold py-3.5 px-6 rounded-xl shadow-lg shadow-purple-950/30 transition-all active:scale-95 cursor-pointer text-sm"
                >
                  + رفع وتجهيز الصور (Load Media)
                </button>
                <button 
                  onClick={loadDemoProject}
                  className="w-full sm:w-auto flex-1 bg-black/60 hover:bg-black/90 border border-purple-500/20 hover:border-purple-500/40 text-slate-350 font-bold py-3.5 px-6 rounded-xl transition-all active:scale-95 cursor-pointer text-sm"
                >
                  تحميل الصفحات النموذجية (Load Sample)
                </button>
              </div>
            </div>
          </div>
        )}

        {activeNavigationTab === 'library' && activeChapterId !== null && images.length > 0 && (
          <>
            {/* Left Sidebar (Thumbnails) */}
            <aside className="w-full lg:w-64 h-32 lg:h-full border-b lg:border-b-0 lg:border-r border-purple-500/10 bg-black/20 flex flex-row lg:flex-col overflow-x-auto lg:overflow-y-auto shrink-0">
              {images.length === 0 && (
                <div className="p-8 text-center text-slate-500 text-sm">
                  Upload a ZIP file to get started.
                </div>
              )}
          {images.map((img, i) => (
            <div
              key={img.id}
              className={`relative flex flex-col gap-2 p-3 border-r lg:border-r-0 border-b-0 lg:border-b border-[#333]/50 text-left transition-colors cursor-pointer group w-28 shrink-0 lg:w-full ${selectedImageId === img.id ? 'bg-[#111]' : 'hover:bg-[#111]/50'}`}
              onClick={() => setSelectedImageId(img.id)}
            >
              <div className="relative aspect-[3/4] w-full bg-black rounded overflow-hidden flex">
                {img.originalDataUrl && (
                  <img src={img.originalDataUrl} alt={`${img.filename} original`} loading="lazy" className="w-1/2 h-full object-cover opacity-80 border-r border-[#444]" />
                )}
                <img src={img.dataUrl} alt={img.filename} loading="lazy" className={`${img.originalDataUrl ? 'w-1/2' : 'w-full'} h-full object-cover opacity-80`} />
                {img.status === 'processing' && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <Loader2 className="animate-spin text-indigo-400" />
                  </div>
                )}
                {img.status === 'done' && (
                  <div className="absolute top-2 right-2 flex gap-1">
                    <span className="bg-emerald-500 text-white text-[10px] uppercase font-bold px-1.5 py-0.5 rounded">Done</span>
                  </div>
                )}
                
                {img.status !== 'done' && (
                  <div className="absolute top-2 right-2" onClick={(e) => e.stopPropagation()}>
                    <input 
                      type="checkbox"
                      checked={selectedForProcess.has(img.id)}
                      onChange={(e) => toggleSelectForProcess(img.id, e as any)}
                      className="w-4 h-4 rounded border-[#444] bg-[#111] text-indigo-600 focus:ring-indigo-500"
                      title="Select for batch processing (Max 5)"
                    />
                  </div>
                )}
                
                {/* Overlays for ordering and deletion */}
                <div className="absolute top-2 left-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                   <button 
                     onClick={(e) => { e.stopPropagation(); moveImageUp(i); }}
                     className="bg-black/80 hover:bg-[#111] text-white p-1 rounded"
                     title="Move Up"
                   >
                     <ChevronUp size={14} />
                   </button>
                   <button 
                     onClick={(e) => { e.stopPropagation(); moveImageDown(i); }}
                     className="bg-black/80 hover:bg-[#111] text-white p-1 rounded"
                     title="Move Down"
                   >
                     <ChevronDown size={14} />
                   </button>
                </div>
                
                <button
                   onClick={(e) => deleteImage(img.id, e)}
                   className="absolute bottom-2 right-2 bg-red-900/80 hover:bg-red-700 text-white p-1.5 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                   title="Delete Image"
                >
                   <Trash2 size={14} />
                </button>
              </div>
              <span className="text-xs truncate w-full" title={img.filename}>{img.filename}</span>
            </div>
          ))}
        </aside>

        {/* Editor Area */}
        <main className="flex-1 p-6 flex flex-col items-center justify-center relative overflow-hidden">
          {selectedImage ? (
            <div className="w-full h-full flex flex-col gap-4">
              <div className="flex justify-between items-center shrink-0">
                <div className="flex items-center gap-3">
                  <h2 className="font-medium text-slate-300">{selectedImage.filename}</h2>
                  
                  {/* Tool selection */}
                  <div className="flex bg-black rounded-lg p-1 border border-[#333] ml-4">
                    <button 
                      onClick={() => setActiveTool('select')}
                      className={`p-1.5 rounded-md ${activeTool === 'select' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                      title="Select/Move"
                    >
                      <MousePointer2 size={16} />
                    </button>
                    <button 
                      onClick={() => setActiveTool('draw')}
                      className={`p-1.5 rounded-md ${activeTool === 'draw' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                      title="Draw"
                    >
                      <Brush size={16} />
                    </button>
                    <button 
                      onClick={() => setActiveTool('erase')}
                      className={`p-1.5 rounded-md ${activeTool === 'erase' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                      title="Erase (White Brush)"
                    >
                      <Eraser size={16} />
                    </button>
                    <button 
                      onClick={() => setActiveTool('fill_poly')}
                      className={`p-1.5 rounded-md ${activeTool === 'fill_poly' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                      title="Fill Polygon (4 points)"
                    >
                      <Palette size={16} />
                    </button>
                    <button 
                      onClick={() => setActiveTool('bg_erase')}
                      className={`p-1.5 rounded-md ${activeTool === 'bg_erase' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                      title="Remove Text Box Background"
                    >
                      <Scissors size={16} />
                    </button>
                    <button 
                      onClick={() => setActiveTool('smart_sfx')}
                      className={`p-1.5 rounded-md ${activeTool === 'smart_sfx' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                      title="Smart Auto-Color (SFX Whitening)"
                    >
                      <Sparkles size={16} />
                     </button>
                     <button 
                      onClick={() => setActiveTool('gen_erase')}
                      className={`p-1.5 rounded-md ${activeTool === 'gen_erase' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
                      title="AI Generative Inpaint (Smart Whitening)"
                    >
                      <Wand2 size={16} />
                    </button>
                    <button 
                      onClick={() => setActiveTool('crop')}
                      className={`p-1.5 rounded-md ${activeTool === 'crop' ? 'bg-indigo-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200 hover:text-indigo-300'}`}
                      title="اقتصاص جزء للترجمة (AI Crop & Translate Panel)"
                    >
                      <Scissors size={16} className="-rotate-90 text-indigo-400" />
                    </button>
                    <div className="w-px bg-slate-700 mx-1 my-1"></div>
                    <button 
                      onClick={() => undo(selectedImage.id)}
                      disabled={!(selectedImage.history && selectedImage.history.length > 0)}
                      className="p-1.5 rounded-md text-slate-400 hover:text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Undo Action"
                    >
                      <Undo size={16} />
                    </button>
                  </div>

                  {/* Zoom controls */}
                  <div className="flex bg-black rounded-lg p-1 border border-[#333]">
                    <button onClick={() => setZoom(z => Math.max(0.2, z - 0.2))} className="p-1.5 text-slate-400 hover:text-slate-200">
                      <ZoomOut size={16} />
                    </button>
                    <span className="text-xs font-mono w-10 text-center flex items-center justify-center text-slate-400">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button onClick={() => setZoom(z => Math.min(3, z + 0.2))} className="p-1.5 text-slate-400 hover:text-slate-200">
                      <ZoomIn size={16} />
                    </button>
                  </div>

                  {/* Manhwa Mode Toggle */}
                  <button
                    onClick={() => {
                      const next = !manhwaMode;
                      setManhwaMode(next);
                      localStorage.setItem('manhwa_mode', String(next));
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border transition-all ${manhwaMode ? 'bg-[#7c3aed]/20 border-[#7c3aed] text-[#a78bfa] shadow-lg font-bold' : 'bg-[#111] border-[#333] text-slate-400 hover:text-slate-200 hover:bg-[#1f1f1f]'}`}
                    title="Adapt layout height to render stacked long strip Manhwa webtoons with scrolling support"
                  >
                    <span className="relative flex h-2 w-2">
                      {manhwaMode && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#a78bfa] opacity-75"></span>}
                      <span className={`relative inline flex rounded-full h-2 w-2 ${manhwaMode ? 'bg-purple-400' : 'bg-slate-500'}`}></span>
                    </span>
                    Manhwa Mode
                  </button>
                  
                  {selectedImage.status !== 'processing' && (
                    <div className="flex items-center gap-2 ml-4 animate-fade-in">
                      {isGeneratingPreviews ? (
                        <div className="flex items-center gap-1.5 bg-blue-950/40 border border-blue-800 text-blue-400 px-3 py-1.5 rounded text-xs font-medium">
                          <Loader2 size={12} className="animate-spin" /> Detecting bubble boxes...
                        </div>
                      ) : showBubblePreviews ? (
                        <div className="flex items-center gap-1.5 bg-blue-950/30 border border-blue-900 px-2 py-1 rounded">
                          <button
                            onClick={() => applyBubblePreviews(selectedImage.id)}
                            className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs px-3 py-1 rounded font-medium transition-colors"
                            title="Apply the safe centered alignment to all detected bubbles"
                          >
                            Apply Centering
                          </button>
                          <button
                            onClick={() => setShowBubblePreviews(false)}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3 py-1 rounded font-medium transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button 
                          onClick={() => generateBubblePreviews(selectedImage.id)}
                          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
                          title="Generate interactive bounds previews highlighted in blue to inspect before alignment"
                        >
                          <Wand2 size={14} /> Preview Bounds
                        </button>
                      )}
                      
                      <button 
                        onClick={() => handleSmartBubbleFillAll(selectedImage.id)}
                        className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded text-xs font-medium transition-colors text-white"
                        title="Smart Center All Text Bubbles"
                      >
                        <Wand2 size={14} /> Center All Bubbles
                      </button>
                      <button 
                        onClick={handleDownloadCurrentPage}
                        className="flex items-center gap-1.5 bg-[#111] hover:bg-[#222] px-3 py-1.5 rounded text-xs font-medium transition-colors"
                        title="Download this page as PNG"
                      >
                        <Download size={14} /> Download Page
                      </button>
                      <button 
                        onClick={() => {
                          if (confirm("Are you sure you want to remove all texts and paint strokes from this page?")) {
                            saveHistory(selectedImage.id);
                            updateImage(selectedImage.id, { regions: [], paintStrokes: [] });
                            setSelectedRegionId(null);
                          }
                        }}
                        className="flex items-center gap-1.5 bg-red-900/50 hover:bg-red-800 px-3 py-1.5 rounded text-xs font-medium transition-colors text-red-200"
                        title="Clear all generated texts and paint strokes"
                      >
                        <Trash2 size={14} /> Clear All
                      </button>
                      <button 
                        onClick={() => {
                          saveHistory(selectedImage.id);
                          const newRegion: Region = {
                            id: Math.random().toString(36).substr(2, 9),
                            type: 'bubble',
                            originalText: '',
                            translatedText: 'New Text',
                            x: selectedImage.width / 2 - 100,
                            y: selectedImage.height / 2 - 50,
                            width: 200,
                            height: 100,
                            angle: 0,
                            textColor: '#000000',
                            strokeColor: 'transparent',
                            strokeWidth: 0,
                            bgColor: '#ffffff',
                            fontFamily: 'Marhey',
                            fontSize: 24,
                            fontWeight: 'normal',
                            fontStyle: 'normal',
                            textAlign: 'center',
                            lineHeight: 1.2,
                            letterSpacing: 0,
                            opacity: 1,
                            shadowBlur: 0,
                            shadowColor: 'transparent',
                            autoFitText: true
                          };
                          updateImage(selectedImage.id, { regions: [...selectedImage.regions, newRegion] });
                          setSelectedRegionId(newRegion.id);
                        }}
                        className="flex items-center gap-1.5 bg-[#111] hover:bg-[#222] px-3 py-1.5 rounded text-xs font-medium transition-colors"
                      >
                        <Plus size={14} /> Add Text
                      </button>
                      <button 
                        onClick={() => {
                          if (selectedForProcess.size > 0) {
                            processSelectedImages();
                          } else {
                            processImage(selectedImage);
                          }
                        }}
                        className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                      >
                        <Play size={14} /> {selectedForProcess.size > 0 ? `Process Selected (${selectedForProcess.size})` : 'Process Image'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {isProcessingCrop && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
                  <div className="bg-black border border-[#444] rounded-xl p-8 flex flex-col items-center gap-4 max-w-sm w-full shadow-2xl animate-fade-in text-center">
                    <Loader2 size={42} className="animate-spin text-indigo-500" />
                    <h3 className="text-sm font-bold text-white tracking-tight">جاري ترجمة ومعالجة المانهوا بالذكاء الاصطناعي...</h3>
                    <p className="text-[11px] text-slate-400 leading-relaxed">يقوم Gemini الآن بتحليل وتبييض ومحاذاة القطاع المقتطع تلقائياً ومطابقته على الصورة الكاملة بدقة فائقة.</p>
                  </div>
                </div>
              )}
              <Suspense fallback={<div className="w-full h-full flex items-center justify-center text-slate-500"><Loader2 className="animate-spin mr-2"/> Loading Editor...</div>}>
                <ImageEditor
                  image={selectedImage}
                  selectedRegionId={selectedRegionId}
                  onSelectRegion={setSelectedRegionId}
                  onUpdateRegion={updateRegion}
                  stageRef={React.createRef()}
                  activeTool={activeTool}
                  brushSize={brushSize}
                  brushColor={brushColor}
                  zoom={zoom}
                  showOriginal={showOriginal}
                  showText={showText}
                  onAddStroke={(stroke) => {
                    saveHistory(selectedImage.id);
                    updateImage(selectedImage.id, {
                      paintStrokes: [...selectedImage.paintStrokes, stroke]
                    });
                  }}
                  onGenerateInpaint={async (base64) => generateInpaint(base64, selectedImage.mimeType, customApiKey)}
                  bubblePreviews={bubblePreviews[selectedImage.id] || []}
                  showBubblePreviews={showBubblePreviews && !showOriginal}
                  manhwaMode={manhwaMode}
                  onProcessCropSection={handleProcessCropSection}
                  onQueueCropSection={handleQueueCropSection}
                />
              </Suspense>

              {cropsQueue.length > 0 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] max-w-2xl bg-black/85 backdrop-blur-xl border border-purple-500/30 rounded-2xl shadow-[0_10px_30px_rgba(147,51,234,0.3)] p-3.5 z-40 flex items-center justify-between gap-4 animate-fade-in">
                  <div className="flex flex-col gap-1 max-w-[45%]">
                    <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 leading-none">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                      AI Batch Crop Queue ({cropsQueue.length} segments)
                    </span>
                    <span className="text-[10px] text-slate-400 leading-tight">
                      Selected segments will be stitched together, translated at once, and mapped back to their original coordinates.
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2 overflow-x-auto max-w-[35%] py-1 border-x border-slate-800/80 px-3 scrollbar-none">
                    {cropsQueue.map((crop) => (
                      <div key={crop.id} className="relative group shrink-0 w-11 h-11 rounded bg-black/50 border border-slate-700/60 overflow-hidden shadow-md">
                        <img src={crop.cropUrl} className="w-full h-full object-cover" />
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setCropsQueue(prev => prev.filter(c => c.id !== crop.id));
                          }}
                          className="absolute top-0 right-0 bg-red-600 hover:bg-red-500 text-white p-0.5 rounded-bl opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center w-4.5 h-4.5 text-[9px] font-bold"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setCropsQueue([])}
                      className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded transition-all cursor-pointer font-medium"
                    >
                      Clear
                    </button>
                    <button
                      onClick={handleTranslateCropQueue}
                      className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-4 py-2 rounded-xl shadow-lg transition-all active:scale-95 cursor-pointer"
                    >
                      <Sparkles size={12} className="text-white shrink-0 animate-pulse" /> ترجمة مجمعة
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-slate-500 flex flex-col items-center gap-4">
              <ImageIcon size={48} className="opacity-50" />
              <p>Select an image to edit</p>
            </div>
          )}
        </main>

        {/* Right Sidebar (Properties) */}
        <aside className="w-full lg:w-80 border-t lg:border-t-0 lg:border-l border-[#333] bg-black flex flex-col overflow-y-auto shrink-0">
          {selectedImage && selectedRegion ? (
            <div className="p-5 flex flex-col gap-6">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <h3 className="font-semibold text-slate-300 flex items-center gap-2">
                    Edit Text <span className="text-[10px] bg-[#111] px-1.5 py-0.5 rounded uppercase tracking-wider text-slate-400">{selectedRegion.type}</span>
                  </h3>
                  <button
                    onClick={() => {
                      saveHistory(selectedImage.id);
                      updateImage(selectedImage.id, {
                        regions: selectedImage.regions.filter(r => r.id !== selectedRegion.id)
                      });
                      setSelectedRegionId(null);
                    }}
                    className="text-red-400 hover:text-red-300 bg-red-950/30 p-1.5 rounded transition-colors"
                    title="Delete Region"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <p className="text-xs text-slate-500 mb-4">{selectedRegion.originalText}</p>
                <textarea
                  value={selectedRegion.translatedText}
                  onChange={(e) => updateRegion(selectedRegion.id, { translatedText: e.target.value })}
                  className="w-full h-24 bg-black border border-[#444] rounded-md p-3 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none resize-none"
                  dir="rtl"
                />
                
                <div className="flex flex-col gap-2 mt-2">
                   <div className="flex gap-2">
                     <button
                       onClick={() => handleFormatLines('diamond')}
                       className="flex-1 bg-[#111] hover:bg-[#222] border border-[#444] text-slate-300 py-1.5 rounded-md text-[10px] font-medium transition-colors"
                     >
                       تنسيق بيضاوي (تمديد)
                     </button>
                     <button
                       onClick={() => handleFormatLines('square')}
                       className="flex-1 bg-[#111] hover:bg-[#222] border border-[#444] text-slate-300 py-1.5 rounded-md text-[10px] font-medium transition-colors"
                     >
                       تنسيق مربع
                     </button>
                   </div>
                   <button
                     onClick={handleSplitBubble}
                     className="w-full flex items-center justify-center gap-1.5 bg-indigo-900/40 hover:bg-indigo-800/60 border border-indigo-500/30 text-indigo-400 py-1.5 rounded-md text-xs font-semibold transition-colors"
                     title="فصل الفقاعة أفقياً إلى فقاعتين"
                   >
                     <Scissors size={12} /> فصل التحديد لفقاعتين
                   </button>
                </div>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5 flex flex-col">
                    <label className="text-xs font-medium text-slate-400">Font Family</label>
                    <select
                      value={selectedRegion.fontFamily}
                      onChange={(e) => updateRegion(selectedRegion.id, { fontFamily: e.target.value })}
                      className="w-full bg-black border border-[#444] rounded-md p-2 text-sm outline-none"
                    >
                      <option value="Cairo">Cairo</option>
                      <option value="Tajawal">Tajawal</option>
                      <option value="Marhey">Marhey</option>
                      <option value="Aref Ruqaa">Aref Ruqaa</option>
                      <option value="Almarai">Almarai</option>
                      <option value="El Messiri">El Messiri</option>
                      <option value="Amiri">Amiri</option>
                      <option value="Changa">Changa</option>
                      <option value="Harmattan">Harmattan</option>
                      <option value="Katibeh">Katibeh</option>
                      <option value="Lalezar">Lalezar</option>
                      <option value="Lemonada">Lemonada</option>
                      <option value="Mada">Mada</option>
                      <option value="Markazi Text">Markazi Text</option>
                      <option value="Reem Kufi">Reem Kufi</option>
                      <option value="Rakkas">Rakkas</option>
                      {customFonts.length > 0 && <optgroup label="Custom Fonts">
                        {customFonts.map(font => (
                          <option key={font.name} value={font.family} style={{ fontFamily: font.family }}>{font.name}</option>
                        ))}
                      </optgroup>}
                    </select>
                    
                    <button 
                      onClick={() => importFontRef.current?.click()}
                      className="mt-1 w-full flex items-center justify-center gap-1.5 bg-purple-900/40 hover:bg-purple-800/60 border border-purple-500/30 text-purple-200 py-1.5 rounded-md text-xs font-medium transition-colors"
                      title="Upload ZIP, TTF, OTF fonts"
                    >
                      <Upload size={12} /> رفع خطوط مخصصة
                    </button>
                    <input 
                      type="file" 
                      ref={importFontRef} 
                      onChange={handleImportFonts} 
                      accept=".zip,.ttf,.otf,.woff" 
                      className="hidden" 
                      multiple 
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Font Size</label>
                    <input
                      type="number"
                      value={Math.round(selectedRegion.fontSize)}
                      onChange={(e) => updateRegion(selectedRegion.id, { fontSize: Number(e.target.value), autoFitText: false })}
                      className="w-full bg-black border border-[#444] rounded-md p-2 text-sm outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Text Align</label>
                    <select
                      value={selectedRegion.textAlign}
                      onChange={(e) => updateRegion(selectedRegion.id, { textAlign: e.target.value })}
                      className="w-full bg-black border border-[#444] rounded-md p-2 text-sm outline-none"
                    >
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                      <option value="left">Left</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Style</label>
                    <div className="flex gap-2">
                       <button onClick={() => updateRegion(selectedRegion.id, { fontWeight: selectedRegion.fontWeight === 'bold' ? 'normal' : 'bold' })} className={`flex-1 p-2 border rounded-md text-sm font-bold ${selectedRegion.fontWeight === 'bold' ? 'bg-indigo-600 border-indigo-600' : 'bg-black border-[#444]'}`}>B</button>
                       <button onClick={() => updateRegion(selectedRegion.id, { fontStyle: selectedRegion.fontStyle === 'italic' ? 'normal' : 'italic' })} className={`flex-1 p-2 border rounded-md text-sm italic ${selectedRegion.fontStyle === 'italic' ? 'bg-indigo-600 border-indigo-600' : 'bg-black border-[#444]'}`}>I</button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Text Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={selectedRegion.textColor}
                        onChange={(e) => updateRegion(selectedRegion.id, { textColor: e.target.value })}
                        className="w-8 h-8 rounded shrink-0 bg-transparent border-0 p-0 cursor-pointer"
                      />
                      <input
                        type="text"
                        value={selectedRegion.textColor}
                        onChange={(e) => updateRegion(selectedRegion.id, { textColor: e.target.value })}
                        className="w-full bg-black border border-[#444] rounded-md p-1.5 text-xs outline-none uppercase"
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Outline (Stroke)</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={selectedRegion.strokeColor === 'transparent' ? '#ffffff' : selectedRegion.strokeColor}
                        onChange={(e) => updateRegion(selectedRegion.id, { strokeColor: e.target.value })}
                        className="w-8 h-8 rounded shrink-0 bg-transparent border-0 p-0 cursor-pointer"
                        disabled={selectedRegion.strokeColor === 'transparent'}
                      />
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          type="range"
                          min="0"
                          max="20"
                          value={selectedRegion.strokeColor === 'transparent' ? 0 : selectedRegion.strokeWidth}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            if (val === 0) updateRegion(selectedRegion.id, { strokeColor: 'transparent', strokeWidth: 0 });
                            else updateRegion(selectedRegion.id, { strokeColor: selectedRegion.strokeColor === 'transparent' ? '#ffffff' : selectedRegion.strokeColor, strokeWidth: val });
                          }}
                          className="w-full accent-indigo-500"
                        />
                        <span className="text-xs font-mono">{selectedRegion.strokeColor === 'transparent' ? 0 : selectedRegion.strokeWidth}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">Background Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={selectedRegion.bgColor === 'transparent' ? '#ffffff' : selectedRegion.bgColor}
                      onChange={(e) => updateRegion(selectedRegion.id, { bgColor: e.target.value })}
                      className="w-8 h-8 rounded shrink-0 bg-transparent border-0 p-0 cursor-pointer"
                      disabled={selectedRegion.bgColor === 'transparent'}
                    />
                    <button 
                      onClick={() => updateRegion(selectedRegion.id, { bgColor: selectedRegion.bgColor === 'transparent' ? '#ffffff' : 'transparent' })}
                      className="text-[10px] bg-[#111] px-2 py-1.5 rounded text-slate-300 w-full"
                    >
                      {selectedRegion.bgColor === 'transparent' ? 'No BG' : 'Clear BG'}
                    </button>
                    {selectedRegion.bgColor !== 'transparent' && ('EyeDropper' in window) && (
                      <button
                        onClick={async () => {
                          try {
                            const eyeDropper = new (window as any).EyeDropper();
                            const result = await eyeDropper.open();
                            updateRegion(selectedRegion.id, { bgColor: result.sRGBHex });
                          } catch (e) {}
                        }}
                        className="p-1 px-2 bg-[#111] hover:bg-[#222] rounded-md text-slate-300 shrink-0 h-[28px]"
                        title="Pick Color from Screen"
                      >
                        <Pipette size={14} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">Angle (Rotation)</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="-180"
                      max="180"
                      value={Math.round(selectedRegion.angle)}
                      onChange={(e) => updateRegion(selectedRegion.id, { angle: Number(e.target.value) })}
                      className="flex-1 accent-indigo-500"
                    />
                    <span className="text-xs w-8 text-right font-mono">{Math.round(selectedRegion.angle)}°</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Letter Spacing</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="-5"
                        max="20"
                        step="0.5"
                        value={selectedRegion.letterSpacing || 0}
                        onChange={(e) => updateRegion(selectedRegion.id, { letterSpacing: Number(e.target.value) })}
                        className="flex-1 accent-indigo-500"
                      />
                      <span className="text-xs w-6 text-right font-mono">{selectedRegion.letterSpacing || 0}</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Opacity (All)</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={selectedRegion.opacity ?? 1}
                        onChange={(e) => updateRegion(selectedRegion.id, { opacity: Number(e.target.value) })}
                        className="flex-1 accent-indigo-500"
                      />
                      <span className="text-xs w-8 text-right font-mono">{Math.round((selectedRegion.opacity ?? 1) * 100)}%</span>
                    </div>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div className="space-y-1.5 flex flex-col justify-end">
                    <label className="flex items-center gap-2 text-xs font-medium text-slate-300 cursor-pointer mb-2">
                      <input 
                        type="checkbox" 
                        checked={!!selectedRegion.autoFitText} 
                        onChange={(e) => updateRegion(selectedRegion.id, { autoFitText: e.target.checked })}
                        className="rounded border-[#444] bg-black accent-indigo-500"
                      />
                      Auto-fit Text
                    </label>
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-medium text-slate-400">Shadow Color</label>
                      <input
                        type="color"
                        value={selectedRegion.shadowColor === 'transparent' ? '#000000' : (selectedRegion.shadowColor || '#000000')}
                        onChange={(e) => updateRegion(selectedRegion.id, { shadowColor: e.target.value })}
                        className="w-6 h-6 rounded shrink-0 bg-transparent border-0 p-0 cursor-pointer"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Shadow Blur ({selectedRegion.shadowBlur || 0})</label>
                    <input
                      type="range"
                      min="0"
                      max="20"
                      value={selectedRegion.shadowBlur || 0}
                      onChange={(e) => updateRegion(selectedRegion.id, { shadowBlur: Number(e.target.value) })}
                      className="w-full accent-indigo-500"
                    />
                  </div>
                </div>

                {/* Dimensions and Coordinates manual inputs in Arabic/English */}
                <div className="space-y-2 border-t border-[#333] pt-4 mt-2">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">الإحداثيات والأبعاد (Dimensions)</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500">X (موضع أفقي)</label>
                      <input 
                        type="number"
                        value={Math.round(selectedRegion.x)}
                        onChange={(e) => updateRegion(selectedRegion.id, { x: Number(e.target.value) })}
                        className="w-full bg-black border border-[#444] rounded-md p-1.5 text-xs text-white outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500">Y (موضع رأسي)</label>
                      <input 
                        type="number"
                        value={Math.round(selectedRegion.y)}
                        onChange={(e) => updateRegion(selectedRegion.id, { y: Number(e.target.value) })}
                        className="w-full bg-black border border-[#444] rounded-md p-1.5 text-xs text-white outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500">Width (العرض)</label>
                      <input 
                        type="number"
                        value={Math.round(selectedRegion.width)}
                        onChange={(e) => updateRegion(selectedRegion.id, { width: Number(e.target.value) })}
                        className="w-full bg-black border border-[#444] rounded-md p-1.5 text-xs text-white outline-none"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500">Height (الارتفاع)</label>
                      <input 
                        type="number"
                        value={Math.round(selectedRegion.height)}
                        onChange={(e) => updateRegion(selectedRegion.id, { height: Number(e.target.value) })}
                        className="w-full bg-black border border-[#444] rounded-md p-1.5 text-xs text-white outline-none"
                      />
                    </div>
                  </div>
                  <div className="space-y-1 mt-2">
                    <label className="text-[10px] text-slate-500">Angle (الزاوية: {selectedRegion.angle || 0}°)</label>
                    <input 
                      type="range"
                      min="-180"
                      max="180"
                      value={selectedRegion.angle || 0}
                      onChange={(e) => updateRegion(selectedRegion.id, { angle: Number(e.target.value) })}
                      className="w-full accent-indigo-500"
                    />
                  </div>
                </div>

                <div className="space-y-1.5 mt-2">
                  <label className="text-xs font-medium text-slate-400">Layer Order</label>
                  <div className="flex gap-2">
                    <button 
                      className="flex-1 bg-[#111] hover:bg-[#222] py-1 rounded text-xs text-slate-300 flex items-center justify-center gap-1"
                      onClick={() => {
                        saveHistory(selectedImage.id);
                        const arr = [...selectedImage.regions];
                        const idx = arr.findIndex(r => r.id === selectedRegion.id);
                        if (idx < arr.length - 1) {
                          [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
                          updateImage(selectedImage.id, { regions: arr });
                        }
                      }}
                    >
                      <ChevronUp size={14} /> Bring Forward
                    </button>
                    <button 
                      className="flex-1 bg-[#111] hover:bg-[#222] py-1 rounded text-xs text-slate-300 flex items-center justify-center gap-1"
                      onClick={() => {
                        saveHistory(selectedImage.id);
                        const arr = [...selectedImage.regions];
                        const idx = arr.findIndex(r => r.id === selectedRegion.id);
                        if (idx > 0) {
                          [arr[idx], arr[idx - 1]] = [arr[idx - 1], arr[idx]];
                          updateImage(selectedImage.id, { regions: arr });
                        }
                      }}
                    >
                      <ChevronDown size={14} /> Send Backward
                    </button>
                  </div>
                </div>

                <div className="pt-4 border-t border-[#333] space-y-2 mt-4">
                   <button 
                     className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs py-2 rounded transition-colors flex items-center justify-center gap-2 font-medium"
                     onClick={() => handleSmartBubbleFill(selectedImage.id, selectedRegion)}
                   >
                     <Wand2 size={14} /> Smart Detect Bubble Bounds
                   </button>
                   <button 
                     className="w-full bg-[#111] hover:bg-[#222] text-slate-200 text-xs py-2 rounded transition-colors flex items-center justify-center gap-2"
                     onClick={() => {
                       saveHistory(selectedImage.id);
                       updateImage(selectedImage.id, {
                         regions: [...selectedImage.regions, {
                           ...selectedRegion,
                           id: crypto.randomUUID(),
                           y: selectedRegion.y + 40
                         }]
                       });
                     }}
                   >
                     <Plus size={14} /> Duplicate text region
                   </button>
                   <button 
                     className="w-full bg-[#111] hover:bg-[#222] text-slate-200 text-xs py-2 rounded transition-colors flex items-center justify-center gap-2"
                     onClick={() => {
                       saveHistory(selectedImage.id);
                       updateImage(selectedImage.id, {
                         regions: selectedImage.regions.map(r => ({
                           ...r, 
                           fontFamily: selectedRegion.fontFamily,
                           fontSize: selectedRegion.fontSize,
                           fontWeight: selectedRegion.fontWeight,
                           fontStyle: selectedRegion.fontStyle,
                           textColor: selectedRegion.textColor,
                           strokeColor: selectedRegion.strokeColor,
                           strokeWidth: selectedRegion.strokeWidth,
                           textAlign: selectedRegion.textAlign
                         }))
                       });
                     }}
                   >
                     <TypeIcon size={14} /> Apply text styles to this page
                   </button>
                   <button 
                     className="w-full bg-[#111] hover:bg-[#222] text-slate-200 text-xs py-2 rounded transition-colors flex items-center justify-center gap-2"
                     onClick={() => {
                       if (confirm('Apply these font settings to all text regions across ALL pages?')) {
                         setImages(prev => prev.map(img => ({
                           ...img,
                           regions: img.regions.map(r => ({
                             ...r, 
                             fontFamily: selectedRegion.fontFamily,
                             fontSize: selectedRegion.fontSize,
                             fontWeight: selectedRegion.fontWeight,
                             fontStyle: selectedRegion.fontStyle,
                             textColor: selectedRegion.textColor,
                             strokeColor: selectedRegion.strokeColor,
                             strokeWidth: selectedRegion.strokeWidth,
                             textAlign: selectedRegion.textAlign
                           }))
                         })));
                       }
                     }}
                   >
                     <TypeIcon size={14} /> Apply text styles to ALL pages
                   </button>
                </div>
              </div>
            </div>
          ) : activeTool !== 'select' ? (
             <div className="p-5 flex flex-col gap-6">
                <div>
                  <h3 className="font-semibold text-slate-300 mb-4 flex items-center gap-2">
                    Brush Settings
                  </h3>
                  
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-slate-400 flex justify-between">
                        <span>Size</span>
                        <span>{brushSize}px</span>
                      </label>
                      <input
                        type="range"
                        min="1"
                        max="100"
                        value={brushSize}
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                        className="w-full accent-indigo-500"
                      />
                    </div>
                    
                    {(activeTool === 'draw' || activeTool === 'fill_poly') && (
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-400">Color</label>
                        <div className="flex items-center gap-2">
                           <input
                            type="color"
                            value={brushColor}
                            onChange={(e) => setBrushColor(e.target.value)}
                            className="w-10 h-10 rounded shrink-0 bg-transparent border-0 p-0 cursor-pointer"
                           />
                           <input
                            type="text"
                            value={brushColor}
                            onChange={(e) => setBrushColor(e.target.value)}
                            className="w-full bg-black border border-[#444] rounded-md p-2 text-sm outline-none uppercase"
                           />
                           {('EyeDropper' in window) && (
                             <button
                               onClick={async () => {
                                 try {
                                   const eyeDropper = new (window as any).EyeDropper();
                                   const result = await eyeDropper.open();
                                   setBrushColor(result.sRGBHex);
                                 } catch (e) {}
                               }}
                               className="p-2 bg-[#111] hover:bg-[#222] rounded-md text-slate-300 shrink-0"
                               title="Pick Color from Screen"
                             >
                               <Pipette size={16} />
                             </button>
                           )}
                        </div>
                      </div>
                    )}
                    
                    {activeTool === 'erase' && (
                      <div className="p-3 bg-black rounded border border-[#333] text-xs text-slate-400 text-center">
                        Eraser paints with white color to match manga background.
                      </div>
                    )}
                    {activeTool === 'bg_erase' && (
                      <div className="p-3 bg-black rounded border border-[#333] text-xs text-slate-400 text-center">
                        Erase parts of a Text's Background square without affecting the text or background image.
                      </div>
                    )}
                    {activeTool === 'smart_sfx' && (
                      <div className="p-3 bg-black rounded border border-[#333] text-xs text-slate-400 text-center">
                        Click on the image. It will automatically pick the background color below the cursor and paint with it! Great for whitening SFX.
                      </div>
                    )}
                    {activeTool === 'gen_erase' && (
                      <div className="p-3 bg-emerald-950/20 rounded border border-emerald-800/30 text-xs text-emerald-400 text-center">
                        AI Generative Inpaint: Draw over a region. The AI algorithm will automatically analyze the surrounding background and cleanly remove text.
                      </div>
                    )}

                    <button 
                      onClick={() => {
                        saveHistory(selectedImage!.id);
                        updateImage(selectedImage!.id, { paintStrokes: [] });
                      }}
                      className="w-full mt-4 bg-red-950/50 hover:bg-red-900/50 border border-red-900/50 text-red-400 py-2 rounded text-sm transition-colors"
                      disabled={!selectedImage || selectedImage.paintStrokes.length === 0}
                    >
                      Clear All Strokes
                    </button>
                  </div>
                </div>
             </div>
          ) : (
             <div className="p-8 text-center text-slate-500 flex flex-col items-center gap-4">
               {selectedImage && <p className="text-sm">Click on any text or bubble in the editor to modify it, or select a drawing tool from the top toolbar.</p>}
             </div>
          )}
        </aside>
          </>
        )}
      </div>

      {/* Dynamic Purple/Black Liquid Glass Bottom Toolbar */}
      {activeChapterId === null && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-6 py-2.5 bg-black/90 backdrop-blur-xl border border-purple-500/25 rounded-full shadow-[0_12px_45px_-8px_rgba(147,51,234,0.45)] flex items-center justify-between gap-10 z-50 transition-all hover:border-purple-500/40">
          
          {/* Left Side Tab Actions (Scheduler, Settings) */}
          <div className="flex items-center gap-6">
            <button 
              type="button"
              onClick={() => setActiveNavigationTab('settings')}
              className={`flex flex-col items-center gap-1 transition-all group ${activeNavigationTab === 'settings' ? 'text-purple-400 scale-105 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <div className={`p-1.5 rounded-xl transition-all ${activeNavigationTab === 'settings' ? 'bg-purple-950/40 shadow-[0_0_12px_rgba(168,85,247,0.2)]' : 'group-hover:bg-white/5'}`}>
                <svg className="w-5 h-5 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx={12} cy={12} r={3} />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </div>
              <span className="text-[10px] font-medium tracking-wide">Settings</span>
            </button>

            <button 
              type="button"
              onClick={() => setActiveNavigationTab('scheduler')}
              className={`flex flex-col items-center gap-1 transition-all group ${activeNavigationTab === 'scheduler' ? 'text-purple-400 scale-105 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <div className={`p-1.5 rounded-xl transition-all ${activeNavigationTab === 'scheduler' ? 'bg-purple-950/40 shadow-[0_0_12px_rgba(168,85,247,0.2)]' : 'group-hover:bg-white/5'}`}>
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <rect x={3} y={4} width={18} height={18} rx={2} ry={2} />
                  <line x1={16} y1={2} x2={16} y2={6} />
                  <line x1={8} y1={2} x2={8} y2={6} />
                  <line x1={3} y1={10} x2={21} y2={10} />
                  <path d="M12 14v4h4" />
                </svg>
              </div>
              <span className="text-[10px] font-medium tracking-wide">Scheduler</span>
            </button>
          </div>

          {/* Central Standalone Black Circular Plus Button */}
          <div className="relative -mt-6">
            <button 
              type="button"
              onClick={() => {
                if (activeMangaId) {
                  if (activeVolumeId) {
                    handleAddChapterPrompt();
                  } else {
                    handleAddVolumePrompt();
                  }
                } else {
                  setShowCreateSeriesModal(true);
                }
              }}
              className="w-14 h-14 bg-black border-2 border-purple-500 rounded-full flex items-center justify-center shadow-[0_5px_22px_rgba(168,85,247,0.55)] cursor-pointer text-white hover:scale-110 active:scale-95 transition-all duration-350"
              title="أنشئ مشروعاً جديداً"
            >
              <svg className="w-6 h-6 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                <line x1={12} y1={5} x2={12} y2={19} />
                <line x1={5} y1={12} x2={19} y2={12} />
              </svg>
            </button>
          </div>

          {/* Right Side Tab Actions (Cloud Storage, Library) */}
          <div className="flex items-center gap-6">
            <button 
              type="button"
              onClick={() => setActiveNavigationTab('cloud')}
              className={`flex flex-col items-center gap-1 transition-all group ${activeNavigationTab === 'cloud' ? 'text-purple-400 scale-105 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <div className={`p-1.5 rounded-xl transition-all ${activeNavigationTab === 'cloud' ? 'bg-purple-950/40 shadow-[0_0_12px_rgba(168,85,247,0.2)]' : 'group-hover:bg-white/5'}`}>
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 10v6M9 13l3 3 3-3" />
                  <path d="M20.88 18.04A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29" />
                </svg>
              </div>
              <span className="text-[10px] font-medium tracking-wide">Cloud</span>
            </button>

            <button 
              type="button"
              onClick={() => setActiveNavigationTab('library')}
              className={`flex flex-col items-center gap-1 transition-all group ${activeNavigationTab === 'library' ? 'text-purple-400 scale-105 font-bold' : 'text-slate-400 hover:text-slate-200'}`}
            >
              <div className={`p-1.5 rounded-xl transition-all ${activeNavigationTab === 'library' ? 'bg-purple-950/40 shadow-[0_0_12px_rgba(168,85,247,0.2)]' : 'group-hover:bg-white/5'}`}>
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                  <rect x={3} y={3} width={7} height={7} rx={1} />
                  <rect x={14} y={3} width={7} height={7} rx={1} />
                  <rect x={14} y={14} width={7} height={7} rx={1} />
                  <rect x={3} y={14} width={7} height={7} rx={1} />
                </svg>
              </div>
              <span className="text-[10px] font-medium tracking-wide">My Library</span>
            </button>
          </div>

        </div>
      )}

      {/* Stunning Create Project Modular popup */}
      {showCreateProjectModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 backdrop-blur-md animate-fade-in">
          <div className="liquid-glass p-8 rounded-3xl max-w-xl w-full mx-4 shadow-[0_20px_50px_rgba(168,85,247,0.3)] border border-purple-500/25 relative text-slate-105 flex flex-col gap-6">
            <button 
              onClick={() => setShowCreateProjectModal(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white p-2 rounded-full hover:bg-white/5 transition-all text-sm font-bold"
            >
              ✕
            </button>
            <div className="flex flex-col gap-1.5 text-left">
              <h2 className="text-2xl font-display font-bold text-white flex items-center gap-2">
                <span className="text-purple-400">✧</span> Create Translation Project
              </h2>
              <p className="text-xs text-slate-400 leading-normal">
                Kickstart a new translation stream from local folders, archived chapters, or restore previous sessions.
              </p>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
              <button 
                onClick={() => {
                  setShowCreateProjectModal(false);
                  fileInputRef.current?.click();
                }}
                className="p-5 rounded-2xl bg-[#080512]/60 hover:bg-purple-950/20 border border-purple-500/15 hover:border-purple-500/45 transition-all flex flex-col gap-2.5 text-left group cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center border border-purple-500/20 text-purple-400">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white group-hover:text-purple-300">Upload ZIP Chapter</h4>
                  <p className="text-[11px] text-slate-400 mt-1">Accepts raw comic image files inside any ZIP.</p>
                </div>
              </button>

              <button 
                onClick={() => {
                  setShowCreateProjectModal(false);
                  cleanZipInputRef.current?.click();
                }}
                className="p-5 rounded-2xl bg-[#080512]/60 hover:bg-purple-950/20 border border-purple-500/15 hover:border-purple-500/45 transition-all flex flex-col gap-2.5 text-left group cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 text-indigo-400">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white group-hover:text-indigo-300">Cleaned Plates ZIP</h4>
                  <p className="text-[11px] text-slate-400 mt-1">Superimpose text directly on white-cleaned pages.</p>
                </div>
              </button>

              <button 
                onClick={() => {
                  setShowCreateProjectModal(false);
                  appendImagesInputRef.current?.click();
                }}
                className="p-5 rounded-2xl bg-[#080512]/60 hover:bg-purple-950/20 border border-purple-500/15 hover:border-purple-500/40 transition-all flex flex-col gap-2.5 text-left group cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center border border-purple-500/20 text-purple-400">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <rect x={3} y={3} width={18} height={18} rx={2} ry={2} />
                    <circle cx={8.5} cy={8.5} r={1.5} />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white group-hover:text-purple-300">Add Raw Pages</h4>
                  <p className="text-[11px] text-slate-400 mt-1">Select and append raw comic files individually.</p>
                </div>
              </button>

              <button 
                onClick={() => {
                  setShowCreateProjectModal(false);
                  projectInputRef.current?.click();
                }}
                className="p-5 rounded-2xl bg-[#080512]/60 hover:bg-purple-950/20 border border-purple-500/15 hover:border-purple-500/45 transition-all flex flex-col gap-2.5 text-left group cursor-pointer"
              >
                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 text-indigo-400">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1={16} y1={13} x2={8} y2={13} />
                    <line x1={16} y1={17} x2={8} y2={17} />
                  </svg>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white group-hover:text-indigo-300">Restore Session State</h4>
                  <p className="text-[11px] text-slate-400 mt-1">Re-import previous workspace state (.json).</p>
                </div>
              </button>
            </div>
            
            <div className="border-t border-purple-500/10 pt-4 flex items-center justify-between gap-4 flex-col sm:flex-row mt-2">
              <span className="text-[11px] text-slate-400 font-mono">💡 No chapters offline? Try the interactive playground.</span>
              <button 
                onClick={() => {
                  setShowCreateProjectModal(false);
                  loadDemoProject();
                }}
                className="px-4 py-2 text-xs font-bold text-white rounded-xl bg-purple-600 hover:bg-purple-500 shadow-lg shadow-purple-900/30 transition-all active:scale-95 cursor-pointer"
              >
                Load Sample Demo Project
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stunning Create Series Modal */}
      {showCreateSeriesModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 backdrop-blur-md animate-fade-in text-right" dir="rtl">
          <div className="liquid-glass p-8 rounded-3xl max-w-lg w-full mx-4 shadow-[0_20px_50px_rgba(168,85,247,0.3)] border border-purple-500/25 relative text-slate-200 flex flex-col gap-5">
            <button 
              onClick={() => setShowCreateSeriesModal(false)}
              className="absolute top-4 left-4 text-slate-400 hover:text-white p-2 rounded-full hover:bg-white/5 transition-all text-sm font-bold"
            >
              ✕
            </button>
            
            <div className="flex flex-col gap-1.5 text-right border-b border-purple-500/10 pb-4">
              <h2 className="text-2xl font-display font-bold text-white flex items-center gap-2 justify-start">
                <span className="text-purple-400">✧</span> إضافة سلسلة جديدة لمكتبتك
              </h2>
              <p className="text-xs text-slate-400">
                أنشئ عملاً أو سلسلة مانجا/مانهوا جديدة لتنظيم وإتباع المجلدات وفصول الترجمة بداخلها.
              </p>
            </div>

            <div className="space-y-4 text-right">
              {/* Cover Upload / URL Preview inline */}
              <div className="space-y-1.5 text-start">
                <label className="text-xs font-semibold text-purple-300 block text-right">صورة غلاف السلسلة (PNG أو JPG):</label>
                <div className="flex items-center gap-4 flex-row-reverse">
                  <div className="w-20 h-24 rounded-lg border border-purple-500/10 bg-[#0c061c] overflow-hidden flex items-center justify-center shrink-0">
                    {newSeriesCoverUrl ? (
                      <img src={newSeriesCoverUrl} alt="Cover Preview" className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon size={20} className="text-purple-500/40" />
                    )}
                  </div>
                  <div className="flex flex-col gap-2 w-full text-right">
                    <input 
                      type="file" 
                      accept="image/*"
                      onChange={handleCoverUpload}
                      id="series-cover-file"
                      className="hidden"
                    />
                    <label 
                      htmlFor="series-cover-file"
                      className="cursor-pointer bg-purple-950/40 hover:bg-purple-900 border border-purple-500/30 text-purple-300 px-4 py-2 rounded-xl text-xs font-bold text-center transition-all block"
                    >
                      اختر صورة من جهازك
                    </label>
                    <span className="text-[10px] text-slate-500 text-center font-mono block">(الموصى به: نسبة طول إلى عرض 4:3)</span>
                  </div>
                </div>
              </div>

              {/* Series Title */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-purple-300 block text-right">عنوان السلسلة:</label>
                <input 
                  type="text"
                  placeholder="مثال: Solo Leveling أو مانهوا سولو ليفنج..."
                  value={newSeriesTitle}
                  onChange={(e) => setNewSeriesTitle(e.target.value)}
                  className="w-full bg-black/60 border border-purple-500/20 hover:border-purple-500/40 focus:border-purple-400 rounded-xl p-3 text-sm text-white outline-none font-sans text-right"
                />
              </div>

              {/* Series Type */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-purple-300 block text-right">النوع (Classification):</label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setNewSeriesType('manga')}
                    className={`p-3 rounded-xl border text-xs font-bold transition-all text-center ${newSeriesType === 'manga' ? 'bg-amber-600/35 border-amber-500 text-amber-200' : 'bg-[#080512]/60 border-purple-500/10 text-slate-400'}`}
                  >
                    Manga (مانجا صفراء)
                  </button>
                  <button
                    onClick={() => setNewSeriesType('manhwa')}
                    className={`p-3 rounded-xl border text-xs font-bold transition-all text-center ${newSeriesType === 'manhwa' ? 'bg-indigo-600/35 border-indigo-500 text-blue-200' : 'bg-[#080512]/60 border-[#555]/10 text-slate-405'}`}
                  >
                    Manhwa (مانهوا ملونة)
                  </button>
                </div>
              </div>

              {/* Series Description */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-purple-300 block text-right">نبذة أو وصف مختصر:</label>
                <textarea 
                  rows={3}
                  placeholder="اكتب وصفاً مختصراً لقصة المانجا أو تفاصيل المترجمين..."
                  value={newSeriesDesc}
                  onChange={(e) => setNewSeriesDesc(e.target.value)}
                  className="w-full bg-black/60 border border-purple-500/20 hover:border-purple-500/40 focus:border-purple-400 rounded-xl p-3 text-sm text-white outline-none resize-none font-sans text-right"
                />
              </div>
            </div>

            <div className="border-t border-purple-500/10 pt-4 flex justify-end gap-3 mt-2">
              <button
                onClick={() => setShowCreateSeriesModal(false)}
                className="bg-black/60 hover:bg-black border border-purple-500/15 hover:border-purple-500/30 text-slate-350 font-bold py-2.5 px-6 rounded-xl text-xs transition-all cursor-pointer"
              >
                إلغاء (Cancel)
              </button>
              <button
                onClick={handleCreateSeries}
                className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold py-2.5 px-7 rounded-xl text-xs transition-all shadow-lg shadow-purple-950/45 cursor-pointer"
              >
                ✓ إنشاء وإضافة السلسلة
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
