import React, { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { Upload, Download, Play, Save, Loader2, Image as ImageIcon, Type as TypeIcon, MousePointer2, Brush, Eraser, PenTool, ZoomIn, ZoomOut, Maximize, Palette, Plus, Pipette, Trash2, ChevronUp, ChevronDown, ImagePlus, Key, Sparkles, Scissors, Undo, Wand2 } from 'lucide-react';
import { extractImagesFromZip, downloadProcessedZip, downloadPdf, downloadSingleImage } from './lib/zip';
import { processMangaPages, generateInpaint, RawRegion } from './lib/gemini';
import { ProcessedImage, Region, PaintStroke } from './types';
import { get, set } from 'idb-keyval';

const ImageEditor = React.lazy(() => import('./components/ImageEditor').then(m => ({ default: m.ImageEditor })));

type Tool = 'select' | 'draw' | 'erase' | 'fill_poly' | 'bg_erase' | 'smart_sfx' | 'gen_erase';

export default function App() {
  const [images, setImages] = useState<ProcessedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [isProcessingAll, setIsProcessingAll] = useState(false);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const [selectedForProcess, setSelectedForProcess] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    get('manga_project').then((saved) => {
      if (saved && Array.isArray(saved) && saved.length > 0) {
        setImages(saved);
        setSelectedImageId(saved[0].id);
      }
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (images.length > 0) {
      const timeout = setTimeout(() => {
        set('manga_project', images).catch(console.error);
      }, 1000);
      return () => clearTimeout(timeout);
    }
  }, [images]);
  
  // Settings State
  const [customApiKey, setCustomApiKey] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

  useEffect(() => {
    const savedKey = localStorage.getItem('manga_gemini_key');
    if (savedKey) setCustomApiKey(savedKey);
  }, []);

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomApiKey(val);
    localStorage.setItem('manga_gemini_key', val);
  };
  
  // Editor State
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [brushSize, setBrushSize] = useState(20);
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [zoom, setZoom] = useState(1);
  const [showOriginal, setShowOriginal] = useState(false);
  const [showText, setShowText] = useState(true);

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

    try {
      const extractedImages = await extractImagesFromZip(file);
      setImages(extractedImages);
      if (extractedImages.length > 0) {
        setSelectedImageId(extractedImages[0].id);
      }
    } catch (error) {
      console.error("Error reading zip", error);
      alert("Failed to read ZIP file.");
    }
  };

  const cleanZipInputRef = useRef<HTMLInputElement>(null);

  const handleCleanedZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const cleanedImages = await extractImagesFromZip(file);
      if (cleanedImages.length === 0) return;

      setImages(prev => {
        const newImages = [...prev];
        // Match by index or filename
        for (let i = 0; i < cleanedImages.length; i++) {
          const cleanInfo = cleanedImages[i];
          const matchIndex = newImages.findIndex(img => img.filename === cleanInfo.filename);
          const targetIndex = matchIndex !== -1 ? matchIndex : i; // fallback to index if names don't match
          
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
      alert('Cleaned images applied successfully! Use "View Original" to see the uncleaned version.');
    } catch (error) {
      console.error("Error reading cleaned zip", error);
      alert("Failed to read Cleaned ZIP file.");
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

  const toggleSelectForProcess = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSet = new Set(selectedForProcess);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      if (newSet.size >= 5) {
        alert("You can select up to 5 images per request.");
        return;
      }
      newSet.add(id);
    }
    setSelectedForProcess(newSet);
  };

  const processSelectedImages = async () => {
    if (selectedForProcess.size === 0) return;
    const batch = images.filter(img => selectedForProcess.has(img.id) && img.status !== 'done');
    if (batch.length === 0) {
       setSelectedForProcess(new Set());
       return;
    }
    
    batch.forEach(img => updateImage(img.id, { status: 'processing', error: undefined }));
    
    try {
      const batchResults = await processMangaPages(
        batch.map(img => ({ id: img.id, base64Image: img.originalDataUrl || img.dataUrl, mimeType: img.mimeType })), 
        customApiKey
      );
      
      batchResults.forEach(result => {
         const img = batch.find(b => b.id === result.id);
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
             lineHeight: raw.lineHeight || 1.2
           };
         });
         
         updateImage(img.id, { status: 'done', regions: newRegions });
      });
      setSelectedForProcess(new Set());
    } catch (err: any) {
       batch.forEach(img => updateImage(img.id, { status: 'error', error: err.message }));
    }
  };

  const processAllImages = async () => {
    setIsProcessingAll(true);
    const uncompleted = images.filter(img => img.status !== 'done');
    
    // Process in batches of 5
    for (let i = 0; i < uncompleted.length; i += 5) {
      const batch = uncompleted.slice(i, i + 5);
      batch.forEach(img => updateImage(img.id, { status: 'processing', error: undefined }));
      
      try {
        const batchResults = await processMangaPages(
          batch.map(img => ({ id: img.id, base64Image: img.originalDataUrl || img.dataUrl, mimeType: img.mimeType })), 
          customApiKey
        );
        
        batchResults.forEach(result => {
           const img = batch.find(b => b.id === result.id);
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
               lineHeight: raw.lineHeight || 1.2
             };
           });
           
           updateImage(img.id, { status: 'done', regions: newRegions });
        });
      } catch (err: any) {
         batch.forEach(img => updateImage(img.id, { status: 'error', error: err.message }));
      }
    }
    
    setIsProcessingAll(false);
  };
  
  const processImage = async (img: ProcessedImage) => {
    if (img.status === 'processing') return;
    updateImage(img.id, { status: 'processing', error: undefined });
    
    try {
      const results = await processMangaPages([{ id: img.id, base64Image: img.originalDataUrl || img.dataUrl, mimeType: img.mimeType }], customApiKey);
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
          lineHeight: raw.lineHeight || 1.2
        };
      });

      updateImage(img.id, { status: 'done', regions: newRegions });
    } catch (error: any) {
      updateImage(img.id, { status: 'error', error: error.message });
    }
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
    <div className="flex flex-col h-screen bg-slate-950 text-slate-200 overflow-hidden font-sans">
      {exportProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-8 flex flex-col items-center gap-4 max-w-md w-full shadow-2xl">
            <Loader2 size={48} className="animate-spin text-emerald-500" />
            <h2 className="text-xl font-bold text-white tracking-tight">Exporting High Quality ZIP</h2>
            <p className="text-sm text-slate-400 text-center">{exportProgress}</p>
          </div>
        </div>
      )}
      {/* Topbar */}
      <header className="h-16 border-b border-slate-800 flex items-center justify-between px-6 bg-slate-900 shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <TypeIcon className="text-emerald-400" />
            <h1 className="font-bold text-xl tracking-tight">MangaAI Translator</h1>
          </div>
          
          <div className="relative">
             <button 
               onClick={() => setShowApiKeyInput(!showApiKeyInput)}
               className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${customApiKey ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400' : 'bg-slate-800 border-slate-700 text-slate-300'}`}
             >
               <Key size={14} />
               API Key
             </button>
             
             {showApiKeyInput && (
               <div className="absolute top-full left-0 mt-2 p-3 bg-slate-800 border border-slate-700 rounded-lg shadow-xl w-72 z-50">
                 <label className="block text-xs font-medium text-slate-300 mb-1.5">Gemini API Key</label>
                 <input 
                   type="password" 
                   value={customApiKey}
                   onChange={handleApiKeyChange}
                   placeholder="Enter your API Key..."
                   className="w-full bg-slate-950 border border-slate-700 rounded-md p-2 text-sm outline-none focus:border-indigo-500"
                 />
                 <p className="text-[10px] text-slate-500 mt-2">Required for using gemini-2.5-flash. Key is saved locally in your browser.</p>
               </div>
             )}
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex bg-slate-800 rounded-md p-1">
            <input 
              type="file" 
              accept=".zip" 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleZipUpload}
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 hover:bg-slate-700 px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
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
              className="flex items-center gap-2 hover:bg-slate-700 px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
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
              className="flex items-center gap-2 hover:bg-slate-700 px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
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
              className="flex items-center gap-1.5 hover:bg-slate-700 px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
              title="Load Project"
            >
              Load State
            </button>
            <button 
              onClick={handleSaveProject}
              disabled={images.length === 0}
              className="flex items-center gap-1.5 hover:bg-slate-700 disabled:opacity-50 px-3 py-1.5 rounded text-sm transition-colors text-slate-300"
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
            className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm transition-colors border ${showOriginal ? 'bg-amber-600 border-amber-600 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
          >
            {showOriginal ? 'Showing Original' : 'View Original'}
          </button>
          
          <button 
            onClick={() => setShowText(!showText)}
            className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm transition-colors border ${!showText ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
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
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 disabled:cursor-not-allowed px-4 py-2 font-medium text-sm text-white transition-colors"
              title="Export as paginated PDF"
            >
              PDF
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar (Thumbnails) */}
        <aside className="w-64 border-r border-slate-800 bg-slate-900/50 flex flex-col overflow-y-auto">
          {images.length === 0 && (
            <div className="p-8 text-center text-slate-500 text-sm">
              Upload a ZIP file to get started.
            </div>
          )}
          {images.map((img, i) => (
            <div
              key={img.id}
              className={`relative flex flex-col gap-2 p-3 border-b border-slate-800/50 text-left transition-colors cursor-pointer group ${selectedImageId === img.id ? 'bg-slate-800' : 'hover:bg-slate-800/50'}`}
              onClick={() => setSelectedImageId(img.id)}
            >
              <div className="relative aspect-[3/4] w-full bg-slate-950 rounded overflow-hidden flex">
                {img.originalDataUrl && (
                  <img src={img.originalDataUrl} alt={`${img.filename} original`} className="w-1/2 h-full object-cover opacity-80 border-r border-slate-700" />
                )}
                <img src={img.dataUrl} alt={img.filename} className={`${img.originalDataUrl ? 'w-1/2' : 'w-full'} h-full object-cover opacity-80`} />
                {img.status === 'processing' && (
                  <div className="absolute inset-0 bg-slate-900/60 flex items-center justify-center">
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
                      className="w-4 h-4 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
                      title="Select for batch processing (Max 5)"
                    />
                  </div>
                )}
                
                {/* Overlays for ordering and deletion */}
                <div className="absolute top-2 left-2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                   <button 
                     onClick={(e) => { e.stopPropagation(); moveImageUp(i); }}
                     className="bg-slate-900/80 hover:bg-slate-800 text-white p-1 rounded"
                     title="Move Up"
                   >
                     <ChevronUp size={14} />
                   </button>
                   <button 
                     onClick={(e) => { e.stopPropagation(); moveImageDown(i); }}
                     className="bg-slate-900/80 hover:bg-slate-800 text-white p-1 rounded"
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
                  <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-800 ml-4">
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
                  <div className="flex bg-slate-900 rounded-lg p-1 border border-slate-800">
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
                  
                  {selectedImage.status !== 'processing' && (
                    <div className="flex items-center gap-2 ml-4">
                      <button 
                        onClick={handleDownloadCurrentPage}
                        className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded text-xs font-medium transition-colors"
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
                            translatedText: 'نص جديد',
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
                            lineHeight: 1.2
                          };
                          updateImage(selectedImage.id, { regions: [...selectedImage.regions, newRegion] });
                          setSelectedRegionId(newRegion.id);
                        }}
                        className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded text-xs font-medium transition-colors"
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
                />
              </Suspense>
            </div>
          ) : (
            <div className="text-slate-500 flex flex-col items-center gap-4">
              <ImageIcon size={48} className="opacity-50" />
              <p>Select an image to edit</p>
            </div>
          )}
        </main>

        {/* Right Sidebar (Properties) */}
        <aside className="w-80 border-l border-slate-800 bg-slate-900/50 flex flex-col overflow-y-auto">
          {selectedImage && selectedRegion ? (
            <div className="p-5 flex flex-col gap-6">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <h3 className="font-semibold text-slate-300 flex items-center gap-2">
                    Edit Text <span className="text-[10px] bg-slate-800 px-1.5 py-0.5 rounded uppercase tracking-wider text-slate-400">{selectedRegion.type}</span>
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
                  className="w-full h-24 bg-slate-950 border border-slate-700 rounded-md p-3 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none resize-none"
                  dir="rtl"
                />
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Font Family</label>
                    <select
                      value={selectedRegion.fontFamily}
                      onChange={(e) => updateRegion(selectedRegion.id, { fontFamily: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-md p-2 text-sm outline-none"
                    >
                      <option value="Cairo">Cairo</option>
                      <option value="Tajawal">Tajawal</option>
                      <option value="Marhey">Marhey</option>
                      <option value="Aref Ruqaa">Aref Ruqaa</option>
                      <option value="Almarai">Almarai</option>
                      <option value="El Messiri">El Messiri</option>
                      <option value="Amiri">Amiri</option>
                      <option value="Changa">Changa</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Font Size</label>
                    <input
                      type="number"
                      value={Math.round(selectedRegion.fontSize)}
                      onChange={(e) => updateRegion(selectedRegion.id, { fontSize: Number(e.target.value) })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-md p-2 text-sm outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Text Align</label>
                    <select
                      value={selectedRegion.textAlign}
                      onChange={(e) => updateRegion(selectedRegion.id, { textAlign: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-md p-2 text-sm outline-none"
                    >
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                      <option value="left">Left</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-slate-400">Style</label>
                    <div className="flex gap-2">
                       <button onClick={() => updateRegion(selectedRegion.id, { fontWeight: selectedRegion.fontWeight === 'bold' ? 'normal' : 'bold' })} className={`flex-1 p-2 border rounded-md text-sm font-bold ${selectedRegion.fontWeight === 'bold' ? 'bg-indigo-600 border-indigo-600' : 'bg-slate-950 border-slate-700'}`}>B</button>
                       <button onClick={() => updateRegion(selectedRegion.id, { fontStyle: selectedRegion.fontStyle === 'italic' ? 'normal' : 'italic' })} className={`flex-1 p-2 border rounded-md text-sm italic ${selectedRegion.fontStyle === 'italic' ? 'bg-indigo-600 border-indigo-600' : 'bg-slate-950 border-slate-700'}`}>I</button>
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
                        className="w-full bg-slate-950 border border-slate-700 rounded-md p-1.5 text-xs outline-none uppercase"
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
                      <input
                        type="number"
                        min="0"
                        max="20"
                        value={selectedRegion.strokeColor === 'transparent' ? 0 : selectedRegion.strokeWidth}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          if (val === 0) updateRegion(selectedRegion.id, { strokeColor: 'transparent', strokeWidth: 0 });
                          else updateRegion(selectedRegion.id, { strokeColor: selectedRegion.strokeColor === 'transparent' ? '#ffffff' : selectedRegion.strokeColor, strokeWidth: val });
                        }}
                        className="w-full bg-slate-950 border border-slate-700 rounded-md p-1.5 text-xs outline-none"
                      />
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
                      className="text-[10px] bg-slate-800 px-2 py-1.5 rounded text-slate-300 w-full"
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
                        className="p-1 px-2 bg-slate-800 hover:bg-slate-700 rounded-md text-slate-300 shrink-0 h-[28px]"
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
                
                <div className="pt-4 border-t border-slate-800 space-y-2 mt-4">
                   <button 
                     className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs py-2 rounded transition-colors flex items-center justify-center gap-2"
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
                     className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs py-2 rounded transition-colors flex items-center justify-center gap-2"
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
                     className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs py-2 rounded transition-colors flex items-center justify-center gap-2"
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
                            className="w-full bg-slate-950 border border-slate-700 rounded-md p-2 text-sm outline-none uppercase"
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
                               className="p-2 bg-slate-800 hover:bg-slate-700 rounded-md text-slate-300 shrink-0"
                               title="Pick Color from Screen"
                             >
                               <Pipette size={16} />
                             </button>
                           )}
                        </div>
                      </div>
                    )}
                    
                    {activeTool === 'erase' && (
                      <div className="p-3 bg-slate-950 rounded border border-slate-800 text-xs text-slate-400 text-center">
                        Eraser paints with white color to match manga background.
                      </div>
                    )}
                    {activeTool === 'bg_erase' && (
                      <div className="p-3 bg-slate-950 rounded border border-slate-800 text-xs text-slate-400 text-center">
                        Erase parts of a Text's Background square without affecting the text or background image.
                      </div>
                    )}
                    {activeTool === 'smart_sfx' && (
                      <div className="p-3 bg-slate-950 rounded border border-slate-800 text-xs text-slate-400 text-center">
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
      </div>
    </div>
  );
}
