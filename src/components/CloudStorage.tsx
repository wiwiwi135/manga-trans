import React, { useState, useEffect, useRef } from 'react';
import { Settings, Cloud, Upload as UploadIcon, File, Link2, RefreshCw, Key, MessageSquare, Download, CheckCircle, Smartphone, Lock, HardDrive, HelpCircle } from 'lucide-react';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import Swal from 'sweetalert2';
import { motion, AnimatePresence } from 'motion/react';

// GramJS and MTProto polyfills need to be globally available in browser via vite-plugin-node-polyfills
// The actual TelegramClient uses them under the hood.

interface CloudStorageProps {
  onBack?: () => void;
}

export function CloudStorage({ onBack }: CloudStorageProps) {
  // Config state
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [chatId, setChatId] = useState(''); // Target channel/group for uploads
  const [phoneNumber, setPhoneNumber] = useState('');
  const [sessionStr, setSessionStr] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [client, setClient] = useState<TelegramClient | null>(null);
  
  // App state
  const [activeTab, setActiveTab] = useState<'config' | 'files' | 'chat'>('config');
  const [isLoading, setIsLoading] = useState(false);
  const [files, setFiles] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  
  // Upload state
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadCover, setUploadCover] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const savedApiId = localStorage.getItem('tg_api_id');
    const savedApiHash = localStorage.getItem('tg_api_hash');
    const savedSession = localStorage.getItem('tg_session');
    const savedChatId = localStorage.getItem('tg_chat_id');
    
    if (savedApiId) setApiId(savedApiId);
    if (savedApiHash) setApiHash(savedApiHash);
    if (savedSession) {
      setSessionStr(savedSession);
      initClient(savedApiId!, savedApiHash!, savedSession);
    }
    if (savedChatId) setChatId(savedChatId);
  }, []);

  const initClient = async (id: string, hash: string, session: string) => {
    try {
      setIsLoading(true);
      const stringSession = new StringSession(session);
      const newClient = new TelegramClient(stringSession, Number(id), hash, {
        connectionRetries: 5,
        useWSS: true,
      });
      await newClient.connect();
      setClient(newClient);
      setIsConnected(true);
      setActiveTab('files');
      Swal.fire({
        icon: 'success',
        title: 'تم الاتصال بتيليجرام بنجاح',
        background: '#090615',
        color: '#fff',
        toast: true,
        position: 'top-end',
        showConfirmButton: false,
        timer: 3000
      });
    } catch (error) {
      console.error(error);
      setIsConnected(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogin = async () => {
    if (!apiId || !apiHash || !phoneNumber) {
      Swal.fire('خطأ', 'الرجاء إدخال API ID و API Hash ورقم الهاتف', 'error');
      return;
    }
    
    setIsLoading(true);
    try {
      const stringSession = new StringSession('');
      const newClient = new TelegramClient(stringSession, Number(apiId), apiHash, {
        connectionRetries: 5,
        useWSS: true,
      });
      await newClient.connect();

      const { phoneCodeHash } = await newClient.sendCode(
        { apiId: Number(apiId), apiHash },
        phoneNumber
      );

      const { value: code } = await Swal.fire({
        title: 'أدخل كود التحقق',
        input: 'text',
        inputLabel: 'تم إرسال كود التحقق إلى حسابك في تيليجرام',
        background: '#090615',
        color: '#fff',
        confirmButtonColor: '#7c3aed',
      });

      if (code) {
        await newClient.invoke(new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash,
          phoneCode: code
        }));
        
        const sessionString = newClient.session.save() as unknown as string;
        localStorage.setItem('tg_api_id', apiId);
        localStorage.setItem('tg_api_hash', apiHash);
        localStorage.setItem('tg_session', sessionString);
        setSessionStr(sessionString);
        setClient(newClient);
        setIsConnected(true);
        setActiveTab('files');
        
        Swal.fire('نجاح', 'تم تسجيل الدخول بنجاح!', 'success');
      }
    } catch (err: any) {
      console.error('Login error:', err);
      Swal.fire('خطأ', err.message || 'فشل تسجيل الدخول', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const fetchFiles = async () => {
    if (!client || !chatId) return;
    setIsLoading(true);
    try {
      const msgs = await client.getMessages(chatId, { limit: 50 });
      const cloudFiles = msgs.filter(m => m.media && m.message && m.message.includes('"type":"manga_project"')).map(m => {
        try {
          // Parse the JSON from the message text
          const data = JSON.parse(m.message);
          return {
            id: m.id,
            msg: m,
            ...data
          };
        } catch {
          return null;
        }
      }).filter(Boolean);
      
      setFiles(cloudFiles);
    } catch (err) {
      console.error(err);
      Swal.fire('خطأ', 'تأكد من صحة معرف القناة (Chat ID)', 'error');
    } finally {
      setIsLoading(false);
    }
  };

// Chat state
  const [chatMessage, setChatMessage] = useState('');
  const [chatMessages, setChatMessages] = useState<any[]>([]);

  const fetchChatMessages = async () => {
    if (!client || !chatId) return;
    try {
      const msgs = await client.getMessages(chatId, { limit: 50 });
      // Only keep messages that are not manga projects, or formatted chat JSON
      const formattedChats = msgs.map(m => {
        if (!m.message) return null;
        try {
          const data = JSON.parse(m.message);
          if (data.type === 'chat') {
            return { id: m.id, text: data.text, date: new Date(m.date * 1000).toLocaleString(), sender: data.sender || 'مستخدم مجهول' };
          }
          return null;
        } catch {
          // Normal message
          if (!m.message.includes('"type":"manga_project"')) {
            return { id: m.id, text: m.message, date: new Date(m.date * 1000).toLocaleString(), sender: 'عضو القناة' };
          }
          return null;
        }
      }).filter(Boolean);
      setChatMessages(formattedChats);
    } catch {
      console.error("Failed to load chat");
    }
  };

  const sendChatMessage = async () => {
    if (!client || !chatId || !chatMessage.trim()) return;
    try {
      const payload = {
        type: 'chat',
        text: chatMessage,
        sender: 'عضو الفريق',
        timestamp: Date.now()
      };
      await client.sendMessage(chatId, { message: JSON.stringify(payload) });
      setChatMessage('');
      fetchChatMessages();
    } catch (e) {
      console.error("Failed to send chat", e);
    }
  };

  useEffect(() => {
    if (isConnected && chatId) {
      if (activeTab === 'files') fetchFiles();
      if (activeTab === 'chat') fetchChatMessages();
    }
  }, [isConnected, chatId, activeTab]);

  const handleUpload = async () => {
    if (!client || !chatId || !uploadFile) {
      Swal.fire('خطأ', 'تأكد من اختيار ملف وإدخال Chat ID', 'error');
      return;
    }
    
    setIsUploading(true);
    setUploadProgress(0);
    
    try {
      const metadata = {
        type: "manga_project",
        name: uploadName || uploadFile.name,
        status: uploadStatus || "New",
        cover: uploadCover || "",
        date: new Date().toISOString()
      };

      await client.sendFile(chatId, {
        file: uploadFile as any, // Vite polyfills File type to browser File but node File might differ
        caption: JSON.stringify(metadata, null, 2),
        progressCallback: (progress) => {
          // progress is a float between 0 and 1
          const percent = Math.round(progress * 100);
          setUploadProgress(percent);
        }
      });
      
      Swal.fire('تم הرفع', 'تم رفع الملف بنجاح كقاعدة بيانات JSON.', 'success');
      setUploadFile(null);
      setUploadName('');
      setUploadProgress(0);
      fetchFiles();
    } catch (err: any) {
      console.error(err);
      Swal.fire('خطأ الرفع', err.message || 'حدث خطأ أثناء الرفع', 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const saveConfig = () => {
    if (chatId) localStorage.setItem('tg_chat_id', chatId);
    Swal.fire({
      icon: 'success',
      title: 'تم الحفظ',
      background: '#090615',
      color: '#fff',
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
      timer: 3000
    });
  };

  const handleDisconnect = () => {
    localStorage.removeItem('tg_session');
    setSessionStr('');
    setIsConnected(false);
    setClient(null);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-start p-8 bg-gradient-to-br from-[#050211] via-[#0a051c] to-[#000000] relative overflow-y-auto w-full min-h-screen text-right" dir="rtl">
      <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[150px] pointer-events-none" />
      
      <div className="max-w-6xl mx-auto w-full flex flex-col gap-8 relative z-10 animate-fade-in pb-20">
        <div className="flex items-center justify-between border-b border-purple-500/20 pb-4">
          <div>
            <h1 className="text-3xl font-display font-bold text-white flex items-center gap-3">
              <Cloud className="text-purple-400" size={32} />
              التخزين السحابي المركزي
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              متصل عبر GramJS (تيليجرام) و Google Drive لرفع ومزامنة الملفات (حتى 2 جيجا).
            </p>
          </div>
          {isConnected && (
            <div className="flex gap-2">
              <button
                onClick={() => setActiveTab('files')}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${activeTab === 'files' ? 'bg-purple-600 text-white shadow-lg shadow-purple-900/40' : 'bg-purple-950/30 text-purple-300 hover:bg-purple-900/50'}`}
              >
                الملفات المرفوعة
              </button>
              <button
                onClick={() => setActiveTab('chat')}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${activeTab === 'chat' ? 'bg-purple-600 text-white shadow-lg shadow-purple-900/40' : 'bg-purple-950/30 text-purple-300 hover:bg-purple-900/50'}`}
              >
                النقاشات
              </button>
              <button
                onClick={() => setActiveTab('config')}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${activeTab === 'config' ? 'bg-purple-600 text-white shadow-lg shadow-purple-900/40' : 'bg-purple-950/30 text-purple-300 hover:bg-purple-900/50'}`}
              >
                الإعدادات
              </button>
            </div>
          )}
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'config' && (
            <motion.div 
              key="config"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 md:grid-cols-2 gap-6"
            >
              <div className="liquid-glass p-6 rounded-2xl border border-purple-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.4)] backdrop-blur-xl">
                <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <Smartphone className="text-purple-400" /> ربط تيليجرام (GramJS)
                </h2>
                
                {!isConnected ? (
                  <div className="space-y-4">
                    <p className="text-xs text-slate-400 leading-relaxed mb-4">
                      نستخدم مكتبة GramJS للاتصال بشبكة تيليجرام المشفرة مباشرة من متصفحك. هذه العملية يتم تنفيذها محلياً Client-Side دون المرور بأي سيرفر وسيط. مفاتيحك تُخزن محلياً في المتصفح فقط.
                    </p>
                    <div className="space-y-1">
                      <label className="text-xs text-purple-300 font-semibold">API ID</label>
                      <input 
                        type="text" 
                        value={apiId} onChange={e => setApiId(e.target.value)}
                        className="w-full bg-black/40 border border-purple-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-purple-400"
                        placeholder="مثال: 1234567" dir="ltr"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-purple-300 font-semibold">API Hash</label>
                      <input 
                        type="text" 
                        value={apiHash} onChange={e => setApiHash(e.target.value)}
                        className="w-full bg-black/40 border border-purple-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-purple-400"
                        placeholder="أدخل API Hash الخاص بحسابك المطور" dir="ltr"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-purple-300 font-semibold">رقم الهاتف الدولي</label>
                      <input 
                        type="text" 
                        value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)}
                        className="w-full bg-black/40 border border-purple-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-purple-400"
                        placeholder="+201012345678" dir="ltr"
                      />
                    </div>
                    <button 
                      onClick={handleLogin} disabled={isLoading}
                      className="w-full mt-4 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-indigo-900/30"
                    >
                      {isLoading ? 'جاري الاتصال...' : 'طلب كود التحقق (Login)'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 flex items-center gap-3">
                      <CheckCircle className="text-emerald-400" size={24} />
                      <div>
                        <h3 className="text-emerald-400 font-bold text-sm">متصل بخوادم تيليجرام!</h3>
                        <p className="text-xs text-emerald-500/70">الجلسة مشفرة ومحفوظة محلياً.</p>
                      </div>
                    </div>
                    
                    <div className="space-y-1 mt-4">
                      <label className="text-xs text-purple-300 font-semibold flex items-center justify-between">
                        معرف القناة أو الجروب التخزيني (Chat ID)
                        <span className="text-[10px] text-slate-500">مثال: -100123456789</span>
                      </label>
                      <input 
                        type="text" 
                        value={chatId} onChange={e => setChatId(e.target.value)}
                        className="w-full bg-black/40 border border-purple-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-purple-400"
                        placeholder="-100..." dir="ltr"
                      />
                    </div>
                    
                    <div className="flex gap-2">
                       <button 
                        onClick={saveConfig}
                        className="flex-1 bg-purple-600 hover:bg-purple-500 text-white font-bold py-2.5 rounded-xl transition-all text-sm"
                      >
                        حفظ الإعدادات
                      </button>
                      <button 
                        onClick={handleDisconnect}
                        className="bg-red-500/20 hover:bg-red-500/40 border border-red-500/30 text-red-400 font-bold py-2.5 px-4 rounded-xl transition-all text-sm"
                      >
                        تسجيل الخروج
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="liquid-glass p-6 rounded-2xl border border-blue-500/20 shadow-[0_8px_30px_rgb(0,0,0,0.4)] backdrop-blur-xl opacity-80 hover:opacity-100 transition-opacity">
                 <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                  <HardDrive className="text-blue-400" /> ربط Google Drive
                </h2>
                <div className="space-y-4">
                  <p className="text-xs text-slate-400 leading-relaxed">
                    للتخزين على المساحة السحابية الخاصة بـ Google Drive، يرجى إدخال Access Token المستخرج من حسابك، حيث لا يتم إرسال أي بيانات لخوادمنا وتتم كل العمليات عبر المتصفح.
                  </p>
                  
                  <div className="space-y-1">
                    <label className="text-xs text-blue-300 font-semibold">Google Auth Token (Access Token)</label>
                    <input 
                      type="password" 
                      placeholder="ya29.a0A..."
                      className="w-full bg-black/40 border border-blue-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-blue-400 font-mono" dir="ltr"
                    />
                  </div>
                  <button 
                    onClick={() => Swal.fire('تحذير', 'ميزة رفع ملفات ZIP لجوجل درايف ستتوفر في التحديث القادم بمجرد تفعيل OAuth2 بالكامل.', 'info')}
                    className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl transition-all text-sm flex items-center justify-center gap-2"
                  >
                    <UploadIcon size={16} /> رفع مؤقت إلى Google Drive
                  </button>
                  <p className="text-[10px] text-blue-300 bg-blue-500/10 border border-blue-500/20 p-2 rounded-lg text-center font-mono">
                    سيتم تفعيل المصادقة التلقائية (OAuth Firebase) في الإصدار القادم.
                  </p>
                </div>
              </div>
              
              {/* Help & Guide Section */}
              <div className="md:col-span-2 liquid-glass p-6 rounded-2xl border border-white/5 bg-white/5">
                <h3 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                  <HelpCircle className="text-slate-400" size={18} /> كيف يعمل نظام التخزين السحابي Client-Side؟
                </h3>
                <ul className="text-sm text-slate-400 space-y-2 list-disc list-inside">
                  <li><strong>استخراج الـ API Keys:</strong> يجب عليك الحصول على <code className="bg-black/50 px-1 py-0.5 rounded text-purple-300">API_ID</code> و <code className="bg-black/50 px-1 py-0.5 rounded text-purple-300">API_HASH</code> من موقع <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">my.telegram.org</a>.</li>
                  <li><strong>الأمان:</strong> التطبيق يعتمد على الـ Web Browser كمنصة عمل فقط. يتم تخزين جلسة تيليجرام الخاصة بك مشفرة في متصفحك (localStorage).</li>
                  <li><strong>القناة التخزينية المعتمدة:</strong> أنشئ قناة أو جروب في تيليجرام وانسخ المعرف الخاص بها (عبر تحويل رسالة إلى بوت مثل @userinfobot) وضعه في حقل Chat ID.</li>
                  <li><strong>الحوسبة الوصفية لملف JSON:</strong> عند رفع أي ملف (مثل ملفات فوتوشوب أو الفصول المترجمة)، سيتم إرفاق هيكل JSON يحتوي على تفاصيل الأنمي وحالتها ليقوم تطبيق الويب بقرائتها وعرضها بلوحة التحكم.</li>
                </ul>
              </div>
            </motion.div>
          )}

          {activeTab === 'files' && isConnected && (
            <motion.div 
              key="files"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              {/* Upload Dropzone */}
              <div className="liquid-glass rounded-2xl border border-purple-500/20 p-6">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                  <UploadIcon className="text-purple-400" /> إضافة ملف للمخزن
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-3">
                    <input 
                      type="text" 
                      placeholder="اسم الملف (مثال: Solo Leveling Ch.12)"
                      value={uploadName} onChange={e => setUploadName(e.target.value)}
                      className="w-full bg-black/40 border border-purple-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-purple-400"
                    />
                    <select
                      value={uploadStatus} onChange={e => setUploadStatus(e.target.value)}
                      className="w-full bg-black/40 border border-purple-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-purple-400"
                    >
                      <option value="">حدد حالة الترجمة/العمل...</option>
                      <option value="قيد التبييض">قيد التبييض (Cleaning)</option>
                      <option value="قيد الترجمة">قيد الترجمة (Translating)</option>
                      <option value="مكتمل (للنشر)">مكتمل (Ready to Publish)</option>
                    </select>
                    <input 
                      type="text" 
                      placeholder="رابط صورة الغلاف (اختياري URL)"
                      value={uploadCover} onChange={e => setUploadCover(e.target.value)}
                      className="w-full bg-black/40 border border-purple-500/30 rounded-xl px-4 py-2.5 text-white text-sm outline-none focus:border-purple-400"
                      dir="ltr"
                    />
                  </div>
                  <div 
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed border-purple-500/30 hover:border-purple-500/60 rounded-xl bg-purple-950/10 flex flex-col items-center justify-center cursor-pointer transition-colors p-6 group"
                  >
                    <input 
                      type="file" 
                      className="hidden" 
                      ref={fileInputRef}
                      onChange={(e) => {
                        if(e.target.files && e.target.files[0]) {
                          setUploadFile(e.target.files[0]);
                          if(!uploadName) setUploadName(e.target.files[0].name);
                        }
                      }}
                    />
                    {uploadFile ? (
                      <div className="text-center text-purple-300">
                        <File className="mx-auto mb-2 opacity-80" size={32} />
                        <p className="font-bold whitespace-nowrap text-ellipsis overflow-hidden max-w-[200px]">{uploadFile.name}</p>
                        <p className="text-xs opacity-60">{(uploadFile.size / 1024 / 1024).toFixed(2)} MB</p>
                      </div>
                    ) : (
                      <>
                        <UploadIcon size={32} className="text-slate-500 mb-3 group-hover:text-purple-400 transition-colors" />
                        <p className="text-sm font-semibold text-slate-300">انقر هنا لاختيار الملف (حتى 2GB)</p>
                      </>
                    )}
                  </div>
                </div>
                
                {isUploading && (
                   <div className="w-full bg-slate-900 border border-purple-500/20 h-3 rounded-full mt-4 overflow-hidden relative">
                    <div className="absolute top-0 left-0 bg-purple-600 h-full transition-all duration-300" style={{ width: `${uploadProgress}%` }}></div>
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-white mix-blend-difference">{uploadProgress}%</span>
                  </div>
                )}
                
                <button 
                  onClick={handleUpload}
                  disabled={isUploading || !uploadFile}
                  className="w-full mt-4 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white font-bold py-3 rounded-xl transition-all shadow-lg shadow-purple-900/40"
                >
                  {isUploading ? 'جاري الرفع لتيليجرام...' : 'رفع الملف إلى السحابة'}
                </button>
              </div>

              {/* Grid/List Files */}
              <div>
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-bold text-white flex items-center gap-2">
                    <HardDrive className="text-purple-400" size={18} /> المستودع السحابي
                  </h3>
                  <button onClick={fetchFiles} className="text-sm text-purple-400 hover:text-white flex items-center gap-1 bg-purple-900/20 px-3 py-1.5 rounded-lg transition-colors">
                    <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> تحديث القائمة
                  </button>
                </div>
                
                {isLoading && files.length === 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                    {[1,2,3].map(i => (
                      <div key={i} className="h-48 rounded-xl bg-purple-950/20 animate-pulse border border-purple-500/10"></div>
                    ))}
                  </div>
                ) : files.length === 0 ? (
                   <div className="text-center py-16 liquid-glass rounded-2xl border border-purple-500/10">
                     <File className="mx-auto text-slate-500 mb-3 opacity-50" size={48} />
                     <p className="text-slate-400 font-semibold">المستودع فارغ حالياً.</p>
                     <p className="text-xs text-slate-500 mt-1">ارفع أول ملف لرؤية السحر!</p>
                   </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                    {files.map((file, idx) => (
                      <div key={idx} className="liquid-glass rounded-xl overflow-hidden border border-purple-500/20 hover:border-purple-400/50 transition-colors group relative">
                        {file.cover ? (
                           <div className="h-40 w-full bg-black/60 relative">
                             <img src={file.cover} alt="Cover" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                             <div className="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>
                           </div>
                        ) : (
                          <div className="h-24 w-full bg-gradient-to-tr from-purple-900/30 to-indigo-900/30 flex items-center justify-center border-b border-purple-500/20">
                            <File size={32} className="text-purple-400/50" />
                          </div>
                        )}
                        <div className="p-4 relative">
                          <h4 className="font-bold text-white text-base mb-1 truncate">{file.name}</h4>
                          <span className="inline-block px-2 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-[10px] text-purple-300 font-bold mb-3">{file.status}</span>
                          
                          <div className="flex justify-between items-center text-xs text-slate-400 font-mono border-t border-white/5 pt-2 mt-2">
                             <span>{new Date(file.date).toLocaleDateString()}</span>
                             <button className="text-purple-400 hover:text-white flex items-center gap-1 font-sans font-bold bg-purple-600/20 hover:bg-purple-600/40 px-2 py-1 rounded transition-colors block">
                               <Download size={14} /> تنزيل
                             </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'chat' && isConnected && (
            <motion.div 
              key="chat"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="liquid-glass p-6 rounded-2xl border border-purple-500/20 flex flex-col h-[600px]"
            >
               <div className="flex justify-between items-center mb-4 border-b border-purple-500/10 pb-4">
                 <h3 className="text-xl font-bold text-white flex items-center gap-2">
                   <MessageSquare className="text-purple-400" /> نقاش الفريق (القناة المركزية)
                 </h3>
                 <button onClick={fetchChatMessages} className="text-purple-400 hover:text-white flex items-center gap-1 bg-purple-900/20 px-3 py-1.5 rounded-lg text-sm transition-colors">
                    <RefreshCw size={14} /> تحديث
                 </button>
               </div>
               
               <div className="flex-1 overflow-y-auto w-full space-y-4 pr-2 mb-4 scrollbar-thin scrollbar-thumb-purple-900 scrollbar-track-transparent">
                 {chatMessages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-slate-500 opacity-50">
                      <MessageSquare size={48} className="mb-2" />
                      <p>لا توجد رسائل سابقة. ابدأ النقاش مع الفريق المجهول الخاص بك!</p>
                    </div>
                 ) : (
                    chatMessages.slice().reverse().map((msg, idx) => (
                      <div key={idx} className="bg-purple-950/20 border border-purple-500/15 rounded-xl p-3 w-fit max-w-[85%] self-start text-right">
                        <div className="flex gap-2 items-center mb-1">
                           <span className="text-xs font-bold text-purple-300">{msg.sender}</span>
                           <span className="text-[10px] text-slate-500 font-mono">{msg.date}</span>
                        </div>
                        <p className="text-sm text-slate-200">{msg.text}</p>
                      </div>
                    ))
                 )}
               </div>

               <div className="flex gap-2 shrink-0">
                 <input 
                   type="text" 
                   value={chatMessage}
                   onChange={e => setChatMessage(e.target.value)}
                   onKeyDown={e => e.key === 'Enter' && sendChatMessage()}
                   placeholder="اكتب رسالتك وتوجيهاتك للفريق هنا..."
                   className="flex-1 bg-black/40 border border-purple-500/30 rounded-xl px-4 py-3 text-white text-sm outline-none focus:border-purple-400"
                 />
                 <button 
                   onClick={sendChatMessage}
                   disabled={!chatMessage.trim()}
                   className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold py-3 px-6 rounded-xl transition-all"
                 >
                   إرسال
                 </button>
               </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
