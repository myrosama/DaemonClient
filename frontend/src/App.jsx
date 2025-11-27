import React, { useState, useEffect, useRef } from 'react';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import LandingPage from './LandingPage';

// --- Firebase Initialization ---
const firebaseConfig = {
  apiKey: "AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8",
  authDomain: "daemonclient-c0625.firebaseapp.com",
  databaseURL: "https://daemonclient-c0625-default-rtdb.firebaseio.com",
  projectId: "daemonclient-c0625",
  storageBucket: "daemonclient-c0625.firebasestorage.app",
  messagingSenderId: "424457448611",
  appId: "1:424457448611:web:bea9f7673fb40f137de316",
  measurementId: "G-72V5NJ7F2C"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();
const appIdentifier = 'default-daemon-client'; 

// --- CONSTANTS ---
const CHUNK_SIZE = 19 * 1024 * 1024;
const UPLOAD_RETRIES = 10;
const DOWNLOAD_RETRIES = 5;
const PROACTIVE_DELAY_MS = 1000;

// --- HELPER FUNCTIONS ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatSpeed(bytes) { 
    if (!bytes || bytes < 1024 || isNaN(bytes)) return `...`; 
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB/s`; 
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`; 
}

function formatETA(seconds) { 
    if (seconds === Infinity || isNaN(seconds) || seconds < 1) return '...'; 
    const h = Math.floor(seconds / 3600); 
    const m = Math.floor((seconds % 3600) / 60); 
    const s = Math.floor(seconds % 60); 
    return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', s > 0 ? `${s}s` : (h===0 && m===0 ? '0s' : '')].filter(Boolean).join(' ') || '...'; 
}

// --- UPLOAD FUNCTION (With Proxy) ---
async function uploadFile(file, botToken, channelId, onProgress, abortSignal, parentId) {
    const totalParts = Math.ceil(file.size / CHUNK_SIZE);
    const uploadedMessageInfo = [];
    let uploadedBytes = 0;
    const startTime = Date.now();
    const proxyBaseUrl = "https://daemonclient-proxy.sadrikov49.workers.dev"; 

    for (let i = 0; i < totalParts; i++) {
        if (abortSignal.aborted) throw new Error("Upload was cancelled by the user.");
        const partNumber = i + 1;
        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        let success = false;

        for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
            if (abortSignal.aborted) throw new Error("Upload was cancelled by the user.");
            try {
                const elapsedTime = (Date.now() - startTime) / 1000 || 1;
                const speed = uploadedBytes / elapsedTime;
                const remainingBytes = file.size - uploadedBytes;
                const eta = (speed > 0 && remainingBytes > 0) ? remainingBytes / speed : Infinity;
                
                onProgress({ 
                    percent: Math.round((uploadedBytes / file.size) * 100), 
                    status: `Uploading part ${partNumber}/${totalParts} (Attempt ${attempt})`, 
                    speed: formatSpeed(speed), 
                    eta: formatETA(eta) 
                });

                const formData = new FormData();
                formData.append('chat_id', channelId);
                formData.append('document', chunk, `${file.name}.part${String(partNumber).padStart(3, '0')}`);
                
                const telegramUploadUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
                const proxyUrl = `${proxyBaseUrl}?url=${encodeURIComponent(telegramUploadUrl)}`;

                const response = await fetch(proxyUrl, { 
                    method: 'POST', 
                    body: formData, 
                    signal: abortSignal 
                });
                
                const result = await response.json();
                
                if (result.ok) {
                    uploadedMessageInfo.push({ message_id: result.result.message_id, file_id: result.result.document.file_id });
                    uploadedBytes += chunk.size;
                    success = true;
                    break; 
                } else {
                    if (response.status === 429 && result.parameters?.retry_after) {
                        const retryAfter = parseInt(result.parameters.retry_after, 10);
                        onProgress(prev => ({ ...prev, status: `Rate limited. Waiting ${retryAfter}s...` }));
                        await sleep(retryAfter * 1000 + 500);
                    } else { await sleep(2000 * attempt); }
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                if (attempt >= UPLOAD_RETRIES) throw new Error(`Part ${partNumber} failed after ${UPLOAD_RETRIES} attempts: ${error.message}`);
                await sleep(3000 * attempt);
            }
        } 
        if (!success) throw new Error(`Upload failed for part ${partNumber}. All retries exhausted.`);
        if (partNumber < totalParts) await sleep(PROACTIVE_DELAY_MS);
    } 
    onProgress({ percent: 100, status: `Upload complete!`, speed: '', eta: ''});
    
    return {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        uploadedAt: firebase.firestore.Timestamp.now(),
        messages: uploadedMessageInfo,
        type: 'file', 
        parentId: parentId
    };
}

// --- HYBRID DOWNLOAD FUNCTION ---
async function downloadFile(fileInfo, botToken, onProgress, abortSignal) {
    const { messages, fileName, fileSize, fileType } = fileInfo;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const CONCURRENT_DOWNLOADS = isMobile ? 3 : 5;
    const totalParts = messages.length;
    let downloadedBytes = 0;
    let completedParts = 0;
    const startTime = Date.now();

    const useFileSystemAPI = !!window.showSaveFilePicker; 
    let fileHandle, writable, fileParts;

    if (useFileSystemAPI) {
        try {
            onProgress({ percent: 0, status: 'Waiting for permission...', speed: '', eta: '' });
            fileHandle = await window.showSaveFilePicker({ suggestedName: fileName });
            writable = await fileHandle.createWritable();
        } catch (err) {
            if (err.name === 'AbortError') { onProgress({ active: false }); return; }
            throw err;
        }
    } else {
        if (fileSize > 500 * 1024 * 1024) { 
             if (!confirm(`This file is large (${(fileSize / 1024 / 1024).toFixed(0)}MB). Downloading huge files on mobile may crash your browser tab due to memory limits. Do you want to try anyway?`)) {
                 onProgress({ active: false });
                 return;
             }
        }
        fileParts = new Array(totalParts);
    }

    async function downloadPartWithRetry(partData) {
        for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
            if (abortSignal.aborted) throw new Error("Download was cancelled by the user.");
            try {
                const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${partData.file_id}`;
                const fileInfoRes = await fetch(fileInfoUrl, { signal: abortSignal });
                const fileInfoData = await fileInfoRes.json();
                
                if (!fileInfoData.ok) {
                    if (fileInfoData.error_code === 429 && fileInfoData.parameters?.retry_after) {
                        const waitTime = fileInfoData.parameters.retry_after;
                        onProgress(prev => ({ ...prev, status: `Rate limited. Waiting ${waitTime}s...` }));
                        await sleep(waitTime * 1000 + 500);
                        continue; 
                    }
                    throw new Error(`TG getFile error: ${fileInfoData.description || "Unknown"}`);
                }

                const filePath = fileInfoData.result.file_path;
                const telegramUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
                const proxyBaseUrl = "https://daemonclient-proxy.sadrikov49.workers.dev"; 
                const proxyUrl = `${proxyBaseUrl}?url=${encodeURIComponent(telegramUrl)}`;
                
                const fileRes = await fetch(proxyUrl, { signal: abortSignal });
                if (!fileRes.ok) throw new Error(`Proxy fetch failed: ${fileRes.status}`);
                return await fileRes.arrayBuffer();

            } catch (error) {
                if (error.name === 'AbortError') throw error;
                if (attempt >= DOWNLOAD_RETRIES) throw error;
                await sleep(2000 * attempt);
            }
        }
    }

    return new Promise((resolve, reject) => {
        const queue = [...messages.entries()]; 
        const worker = async () => {
            while (queue.length > 0) {
                if (abortSignal.aborted) {
                    if (writable) await writable.abort();
                    reject(new Error("Download was cancelled."));
                    return;
                }

                const [index, partData] = queue.shift();
                try {
                    const chunkData = await downloadPartWithRetry(partData);
                    if (useFileSystemAPI) {
                        const position = index * CHUNK_SIZE;
                        await writable.write({ type: 'write', position: position, data: chunkData });
                    } else {
                        fileParts[index] = chunkData;
                    }

                    downloadedBytes += chunkData.byteLength;
                    completedParts++;
                    const elapsedTime = (Date.now() - startTime) / 1000 || 1;
                    const speed = downloadedBytes / elapsedTime;
                    const remainingBytes = fileSize - downloadedBytes;
                    const eta = (remainingBytes > 0 && speed > 0) ? remainingBytes / speed : 0;
                    
                    onProgress({ 
                        percent: Math.round((downloadedBytes / fileSize) * 100), 
                        status: `Downloaded part ${completedParts}/${totalParts}...`, 
                        speed: formatSpeed(speed), 
                        eta: formatETA(eta) 
                    });
                    
                    if (completedParts === totalParts) {
                        if (useFileSystemAPI) {
                            await writable.close();
                        } else {
                            onProgress({ percent: 100, status: `Assembling file...`, speed: '', eta: '' });
                            const blob = new Blob(fileParts, { type: fileType });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = fileName;
                            document.body.appendChild(a); 
                            a.click(); 
                            document.body.removeChild(a);
                            setTimeout(() => URL.revokeObjectURL(url), 10000); 
                        }
                        onProgress({ percent: 100, status: `Download complete!`, speed: '', eta: '' });
                        resolve();
                        return; 
                    }
                } catch (error) {
                    if (writable) await writable.abort(); 
                    reject(error);
                    return; 
                }
            }
        };
        onProgress({ percent: 0, status: 'Starting download...', speed: '', eta: '' });
        for (let i = 0; i < CONCURRENT_DOWNLOADS; i++) { worker(); }
    });
}

// --- DELETE FUNCTION ---
async function deleteTelegramMessages(botToken, channelId, messages) {
    for (const message of messages) {
        try {
            await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: channelId, message_id: message.message_id })
            });
        } catch (error) { console.error(`Network error deleting message ${message.message_id}:`, error); }
        await sleep(350);
    }
}

// --- UI COMPONENTS ---
const LoaderComponent = ({ small }) => <div className={`animate-spin rounded-full border-b-2 border-white ${small ? 'h-6 w-6' : 'h-10 w-10'}`}></div>;
const LogoComponent = () => <img src="/logo.png" alt="DaemonClient Logo" className="h-16 w-auto" />; 
const FullScreenLoader = ({message}) => <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white"><LoaderComponent /><p className="mt-4 text-lg">{message || "Loading Application..."}</p></div>;
const RenameIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
const FolderIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-300 w-5 h-5 mr-3 flex-shrink-0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>;
const FileIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 w-5 h-5 mr-3 flex-shrink-0"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>;
const CreateFolderIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>;
const SettingsIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 0 2.4l-.15.08a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l-.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1 0-2.4l.15.08a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>;
const ChevronIcon = ({ open }) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`inline-block ml-1 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"></polyline></svg>;

const ProgressBar = ({ percent, status, speed, eta, onCancel }) => (
    <div className="w-full mt-4">
        <div className="flex justify-between items-center mb-1 text-xs text-gray-300">
            <span>{status}</span>
            <div className="flex items-center">
                <span className="mr-4">{eta || '...'}</span>
                {onCancel && <button onClick={onCancel} className="text-red-400 hover:text-red-300 text-xs font-bold">CANCEL</button>}
            </div>
        </div>
        <div className="w-full bg-gray-600 rounded-full h-2.5"><div className="bg-indigo-500 h-2.5 rounded-full" style={{ width: `${percent}%` }}></div></div>
        <div className="text-center text-sm font-semibold text-indigo-300 mt-1">{speed || '...'}</div>
    </div>
);

const SettingsModal = ({ initialConfig, onSave, onClose, isSaving }) => {
    const [botToken, setBotToken] = useState(initialConfig.botToken || '');
    const [channelId, setChannelId] = useState(initialConfig.channelId || '');
    const [error, setError] = useState('');
    const handleSave = async () => {
        if (!botToken.trim() || !channelId.trim()) { setError("Bot Token and Channel ID cannot be empty."); return; }
        setError('');
        try { await onSave({ botToken, channelId }); } catch (err) { setError(`Save failed: ${err.message}`); }
    };
    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 font-sans">
            <div className="bg-gray-800 rounded-xl shadow-2xl p-8 w-full max-w-lg">
                <h2 className="text-2xl font-bold text-indigo-400 mb-4">Settings</h2>
                <div className="space-y-4">
                    <div>
                        <label htmlFor="botToken-settings" className="block text-sm font-medium text-gray-300 mb-1">Telegram Bot Token</label>
                        <input id="botToken-settings" type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white" />
                    </div>
                    <div>
                        <label htmlFor="channelId-settings" className="block text-sm font-medium text-gray-300 mb-1">Private Channel ID</label>
                        <input id="channelId-settings" type="text" value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white" />
                    </div>
                    {error && <p className="text-red-400 text-sm text-center py-1">{error}</p>}
                </div>
                <div className="flex justify-end space-x-4 mt-6">
                    <button onClick={onClose} disabled={isSaving} className="py-2 px-4 bg-gray-600 hover:bg-gray-500 rounded-lg text-white">Cancel</button>
                    <button onClick={handleSave} disabled={isSaving} className="py-2 px-6 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-white flex items-center justify-center w-24">
                        {isSaving ? <LoaderComponent small={true} /> : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
};

const AuthView = () => {
    const [isLoginView, setIsLoginView] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isExplanationVisible, setIsExplanationVisible] = useState(false);
    const [isTermsModalOpen, setIsTermsModalOpen] = useState(false);
    const [hasAgreedToTerms, setHasAgreedToTerms] = useState(false);

    const handleAuthAction = async (e) => {
        e.preventDefault();
        if (!isLoginView && !hasAgreedToTerms) {
            setError("You must agree to the Terms of Use to create an account.");
            return;
        }
        if (!email || !password) {
            setError("Please enter email and password.");
            return;
        }
        setIsLoading(true);
        setError(''); 
        try {
            if (isLoginView) {
                await auth.signInWithEmailAndPassword(email, password);
            } else {
                await auth.createUserWithEmailAndPassword(email, password);
            }
        } catch (err) {
            switch (err.code) {
                case 'auth/user-not-found':
                case 'auth/wrong-password':
                case 'auth/invalid-credential':
                    setError("Invalid credentials. Please check your email and password.");
                    break;
                case 'auth/too-many-requests':
                    setError("Too many login attempts. Please try again later.");
                    break;
                case 'auth/email-already-in-use':
                    setError("An account with this email already exists. Please log in instead.");
                    break;
                case 'auth/weak-password':
                    setError("Password is too weak. It should be at least 6 characters long.");
                    break;
                case 'auth/invalid-email':
                    setError("The email address format is not valid.");
                    break;
                default:
                    setError("An unexpected error occurred. Please try again.");
                    break;
            }
        } finally {
            setIsLoading(false);
        }
    };

    return (
            <div className="flex flex-col items-center justify-center w-full min-h-screen p-4 py-8 font-sans text-white">
            <div className="w-full max-w-md">
                <div className="text-center mb-8">
                    <div className="flex items-center justify-center mb-2">
                    <LogoComponent />
                 </div>
                    <h1 className="text-4xl font-bold text-white">DaemonClient</h1>
                    <p className="text-indigo-300 mt-2">Your Secure Cloud Storage</p>
                </div>
                <div className="bg-gray-800 shadow-2xl rounded-xl p-8">
                    <div className="flex border-b border-gray-700 mb-6">
                        <button onClick={() => { setIsLoginView(true); setError(''); }} className={`w-1/2 py-3 text-lg font-semibold ${isLoginView ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500'}`}>Login</button>
                        <button onClick={() => { setIsLoginView(false); setError(''); }} className={`w-1/2 py-3 text-lg font-semibold ${!isLoginView ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500'}`}>Sign Up</button>
                    </div>
                    <form onSubmit={handleAuthAction} className="space-y-6">
                        <div>
                            <label htmlFor="email-auth" className="block text-sm font-medium text-gray-300 mb-2">Email Address</label>
                            <input id="email-auth" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white" required />
                        </div>
                        <div>
                            <label htmlFor="password-auth" className="block text-sm font-medium text-gray-300 mb-2">Password</label>
                            <input id="password-auth" type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white" required />
                        </div>
                        
                        {!isLoginView && (
                            <div className="flex items-center">
                                <input 
                                    id="terms-agree" 
                                    type="checkbox" 
                                    checked={hasAgreedToTerms} 
                                    onChange={(e) => setHasAgreedToTerms(e.target.checked)}
                                    className="h-4 w-4 rounded border-gray-500 bg-gray-700 text-indigo-600 focus:ring-indigo-500"
                                />
                                <label htmlFor="terms-agree" className="ml-2 block text-sm text-gray-300">
                                    I agree to the{' '}
                                    <button 
                                        type="button" 
                                        onClick={() => setIsTermsModalOpen(true)} 
                                        className="font-medium text-indigo-400 hover:text-indigo-300"
                                    >
                                        Terms of Use
                                    </button>
                                </label>
                            </div>
                        )}

                        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
                        <div>
                            <button type="submit" disabled={isLoading || (!isLoginView && !hasAgreedToTerms)} className="w-full flex justify-center py-3 px-4 rounded-lg text-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 disabled:opacity-75">
                                {isLoading ? <LoaderComponent small={true} /> : (isLoginView ? 'Log In' : 'Create Account')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
            <div className="w-full max-w-2xl mt-8 text-center">
                <button onClick={() => setIsExplanationVisible(!isExplanationVisible)} className="text-gray-400 hover:text-indigo-400 transition-colors py-2">What is DaemonClient?<ChevronIcon open={isExplanationVisible} /></button>
                <div className={`text-left overflow-hidden transition-all duration-500 ease-in-out ${isExplanationVisible ? 'max-h-[1000px] opacity-100 mt-4' : 'max-h-0 opacity-0'}`}>
                    <div className="text-gray-300 space-y-4 bg-gray-800/50 backdrop-blur-sm p-6 rounded-lg shadow-lg border border-gray-700">
                        <p>DaemonClient is a novel, zero-knowledge cloud storage platform that transforms your personal Telegram account into a secure, private, and virtually limitless file vault.</p>
                        <h3 className="text-lg font-semibold text-white pt-2">How It Works: A Decentralized Architecture</h3>
                        <ul className="list-disc list-inside space-y-2 pl-2">
                            <li><strong>True Privacy:</strong> Your files are chunked, encrypted in transit, and stored in a private Telegram channel that only you and your personal bot can access. The DaemonClient developers have zero ability to see or access your files.</li>
                            <li><strong>Zero Cost:</strong> By leveraging Telegram's generous file storage policies, this architecture provides terabytes of storage at no cost.</li>
                            <li><strong>Full Control:</strong> You own the storage infrastructure. All file operations are managed client-side, directly between your browser and the Telegram API, ensuring your data never passes through our servers after the initial setup.</li>
                        </ul>
                        <p className="pt-2 text-gray-400 text-sm">This tool requires you to create your own free Telegram bot and a private channel, allowing you to maintain a zero-cost, private storage infrastructure.</p>
                        <div className="pt-5 mt-5 border-t border-gray-700 text-center"><a href="https://t.me/montclier49" target="_blank" rel="noopener noreferrer" className="text-sm text-gray-500 hover:text-indigo-400 transition-colors">A project by @montclier49</a></div>
                    </div>
                </div>
            </div>
            {isTermsModalOpen && <TermsModal onClose={() => setIsTermsModalOpen(false)} />}
        </div>
    );
};

const TermsModal = ({ onClose }) => {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 font-sans" onClick={onClose}>
            <div className="bg-gray-800 rounded-xl shadow-2xl p-8 w-full max-w-3xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-bold text-indigo-400 mb-4">Terms of Use for DaemonClient</h2>
                <div className="text-gray-300 space-y-4 text-sm">
                    <p className="text-gray-400">Last Updated: September 19, 2025</p>
                    <h3 className="font-semibold text-white pt-2">1. The Service</h3>
                    <p>DaemonClient ("the Service") is a software tool that allows users to leverage their personal Telegram account as a cloud storage backend. The Service is provided "as-is" without any warranties. We are not a file-hosting company; we provide a tool for you to manage your own storage.</p>
                    <h3 className="font-semibold text-white pt-2">2. User Responsibility and Data Ownership</h3>
                    <p>You, the user, are solely responsible for the data you store using the Service. All files are stored in a private Telegram channel and managed by a Telegram bot to which you are given full ownership. We, the developers, have zero-knowledge of or access to your stored files.</p>
                    <p>You agree not to use the Service to store any content that is illegal, infringes on copyright, or violates Telegram's Terms of Service.</p>
                    <h3 className="font-semibold text-white pt-2">3. Platform Dependency and Risk of Data Loss</h3>
                    <p>The Service is critically dependent on the APIs and policies of third-party platforms, primarily Telegram. These platforms may change their services, policies, or APIs at any time without notice. Such changes could render DaemonClient partially or completely non-functional, potentially leading to the loss of access to your data. By using the Service, you acknowledge and accept this risk. We are not liable for any data loss resulting from third-party platform changes.</p>
                    <h3 className="font-semibold text-white pt-2">4. Limitation of Liability</h3>
                    <p>In no event shall the developers of DaemonClient be liable for any direct, indirect, special, incidental, or consequential damages arising out of the use or inability to use the Service, including but not limited to data loss, even if we have been advised of the possibility of such damages.</p>
                    <h3 className="font-semibold text-white pt-2">5. Termination</h3>
                    <p>We reserve the right to terminate your access to the Service's authentication system at any time if you are found to be in violation of these terms.</p>
                    <div className="text-center pt-4">
                        <button onClick={onClose} className="py-2 px-6 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-white">Close</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const FileItem = ({ item, isEditing, renameValue, setRenameValue, onSaveRename, onCancelRename, onStartRename, onDownload, onDelete, onFolderClick, isBusy }) => {
    const isFolder = item.type === 'folder';

    if (isEditing) {
        return (
            <div className="flex justify-between items-center bg-gray-900 p-3 rounded-lg">
                <input type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSaveRename(item.id, renameValue); if (e.key === 'Escape') onCancelRename(); }} className="w-full p-1 bg-gray-700 border border-indigo-500 rounded text-white text-sm" autoFocus />
                <div className="flex items-center space-x-2 ml-2">
                    <button onClick={() => onSaveRename(item.id, renameValue)} className="bg-green-600 hover:bg-green-700 text-white font-bold py-1 px-3 rounded-md text-sm">Save</button>
                    <button onClick={onCancelRename} className="bg-gray-600 hover:bg-gray-500 text-white py-1 px-3 rounded-md text-sm">Cancel</button>
                </div>
            </div>
        );
    }

    return (
        <div 
            className={`flex justify-between items-center bg-gray-800 p-3 rounded-lg transition-colors ${isFolder ? 'hover:bg-gray-700 cursor-pointer' : 'hover:bg-gray-750'}`}
            onClick={isFolder ? () => onFolderClick(item) : undefined}
        >
            <div className="flex items-center overflow-hidden">
                {isFolder ? <FolderIcon /> : <FileIcon />}
                <div>
                    <p className="font-semibold text-white truncate w-40 md:w-60" title={item.fileName}>{item.fileName}</p>
                    {!isFolder && (
                        <p className="text-xs text-gray-400">{(item.fileSize / 1024 / 1024).toFixed(2)} MB {item.uploadedAt?.toDate ? ` - ${item.uploadedAt.toDate().toLocaleDateString()}` : ''}</p>
                    )}
                </div>
            </div>
            <div className="flex items-center space-x-2" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onStartRename(item.id, item.fileName)} disabled={isBusy} className="text-blue-400 hover:text-blue-300 disabled:text-gray-600 disabled:cursor-not-allowed p-1" title="Rename"><RenameIcon /></button>
                <button onClick={() => onDelete(item)} disabled={isBusy} className="bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-1 px-3 rounded-md text-sm">Delete</button>
                {!isFolder && (
                    <button onClick={() => onDownload(item)} disabled={isBusy} className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-1 px-3 rounded-md text-sm">Download</button>
                )}
            </div>
        </div>
    );
};

const Breadcrumbs = ({ hierarchy, onNavigate }) => {
    return (
        <div className="flex items-center space-x-2 text-sm text-gray-400 mb-4">
            {hierarchy.map((folder, index) => (
                <React.Fragment key={folder.id}>
                    <button 
                        onClick={() => onNavigate(folder.id, index)} 
                        className={`hover:text-white ${index === hierarchy.length - 1 ? 'text-white font-semibold' : ''}`}
                    >
                        {folder.name}
                    </button>
                    {index < hierarchy.length - 1 && <span>/</span>}
                </React.Fragment>
            ))}
        </div>
    );
};

const DashboardView = () => {
    const [config, setConfig] = useState(null); 
    const [isLoadingConfig, setIsLoadingConfig] = useState(true); 
    const [configError, setConfigError] = useState(''); 
    
    const [items, setItems] = useState([]); 
    const [totalItems, setTotalItems] = useState(0);
    const [currentFolderId, setCurrentFolderId] = useState('root');
    const [folderHierarchy, setFolderHierarchy] = useState([{ id: 'root', name: 'Root' }]);

    const [isLoadingFiles, setIsLoadingFiles] = useState(true); 
    const [uploadProgress, setUploadProgress] = useState({ active: false });
    const [downloadProgress, setDownloadProgress] = useState({ active: false });
    const [feedbackMessage, setFeedbackMessage] = useState({ type: '', text: ''});
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSavingSettings, setIsSavingSettings] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [abortController, setAbortController] = useState(null);
    const [editingFileId, setEditingFileId] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    
    const [uploadQueue, setUploadQueue] = useState([]);
    const [uploadBatchTotal, setUploadBatchTotal] = useState(0);

    const fileInputRef = useRef(null);
    const isUploading = uploadProgress.active;
    const isDownloading = downloadProgress.active;
    const isRenaming = editingFileId !== null;
    const isBusy = isUploading || isDownloading || isRenaming;

    useEffect(() => {
        const currentAuthUser = auth.currentUser;
        if (!currentAuthUser) {
            setIsLoadingConfig(false); setIsLoadingFiles(false); setConfig(null); setItems([]);
            return;
        }
        
        const currentUserID = currentAuthUser.uid;
        
        const configDocRef = db.collection(`artifacts/${appIdentifier}/users/${currentUserID}/config`).doc('telegram');
        configDocRef.get().then(configSnap => {
            if (configSnap.exists && configSnap.data().botToken) {
                setConfig(configSnap.data());
            } else {
                setConfigError("Configuration not found. Please complete the one-time setup.");
                setConfig(null);
            }
        }).catch(error => {
            setConfigError(`Error loading config: ${error.message}.`);
            setConfig(null);
        }).finally(() => {
            setIsLoadingConfig(false);
        });

        setIsLoadingFiles(true);
        const itemsQuery = db.collection(`artifacts/${appIdentifier}/users/${currentUserID}/files`)
                            .where('parentId', '==', currentFolderId)
                            .orderBy('type', 'desc') 
                            .orderBy('fileName', 'asc');

        const unsubscribe = itemsQuery.onSnapshot(filesSnap => {
            const filesData = filesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            setItems(filesData);
            setTotalItems(filesData.length);
            setIsLoadingFiles(false);
        }, error => {
            setFeedbackMessage({type: 'error', text: `Error loading files: ${error.message}`});
            setIsLoadingFiles(false);
            const timer = setTimeout(() => setFeedbackMessage({type: '', text: ''}), 5000);
            return () => clearTimeout(timer);
        });

        return () => unsubscribe(); 

    }, [currentFolderId]);
    
    const clearFeedback = (delay = 5000) => setTimeout(() => setFeedbackMessage({type: '', text: ''}), delay);
    const handleCancelTransfer = () => { if (abortController) { abortController.abort(); setAbortController(null); setUploadQueue([]); setUploadProgress({ active: false }); setDownloadProgress({ active: false }); setFeedbackMessage({ type: 'info', text: 'Operation cancelled.' }); clearFeedback(); } };
    
    const handleFileUpload = (e) => {
        const newFiles = e.target.files;
        if (!newFiles.length) return;
        if (!config?.botToken) {
            setFeedbackMessage({type: 'error', text: "Bot configuration not loaded."});
            clearFeedback();
            return;
        }
        const newFilesArray = Array.from(newFiles);
        setUploadQueue(prevQueue => [...prevQueue, ...newFilesArray]);
        if (uploadQueue.length === 0) {
            setUploadBatchTotal(newFilesArray.length);
        } else {
            setUploadBatchTotal(prevTotal => prevTotal + newFilesArray.length);
        }
        if(fileInputRef.current) fileInputRef.current.value = ""; 
    };

    useEffect(() => {
        if (isUploading || uploadQueue.length === 0) {
            return;
        }

        const startNextUpload = async () => {
            const fileToUpload = uploadQueue[0];
            const controller = new AbortController();
            setAbortController(controller);
            
            const currentFileNumber = uploadBatchTotal - uploadQueue.length + 1;
            const statusPrefix = `Uploading '${fileToUpload.name}' (${currentFileNumber}/${uploadBatchTotal})`;

            setUploadProgress({ active: true, percent: 0, status: statusPrefix, speed: '', eta: '' });
            setFeedbackMessage({ type: '', text: '' });

            try {
                const newFileData = await uploadFile(
                    fileToUpload, 
                    config.botToken, 
                    config.channelId, 
                    (p) => setUploadProgress(prev => ({ ...prev, ...p, status: `${statusPrefix} - ${p.status}`, active: true })), 
                    controller.signal,
                    currentFolderId
                );

                const newFileRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/files`).doc();
                await newFileRef.set({ id: newFileRef.id, ...newFileData });

                setFeedbackMessage({ type: 'success', text: `Uploaded '${fileToUpload.name}'` });
            
            } catch (err) {
                if (err.name !== 'AbortError') {
                    setFeedbackMessage({ type: 'error', text: `Upload failed for '${fileToUpload.name}': ${err.message}` });
                }
            } finally {
                setUploadProgress({ active: false });
                setAbortController(null);
                const nextQueue = uploadQueue.slice(1);
                setUploadQueue(nextQueue);
                if (nextQueue.length === 0) {
                    setUploadBatchTotal(0);
                    clearFeedback();
                }
            }
        };

        startNextUpload();
    }, [uploadQueue, isUploading, currentFolderId]);

    const handleFileDownload = async (fileInfo) => {
        if (!config?.botToken) { setFeedbackMessage({type: 'error', text: "Bot configuration not loaded."}); clearFeedback(); return; }
        if (!fileInfo?.messages?.length) { setFeedbackMessage({type: 'error', text: "File info incomplete."}); clearFeedback(); return; }
        const controller = new AbortController(); setAbortController(controller);
        setDownloadProgress({ active: true, percent: 0, status: 'Preparing download...', speed: '', eta: '' }); setFeedbackMessage({type: '', text: ''});
        try {
            await downloadFile(fileInfo, config.botToken, (p) => setDownloadProgress(prev => ({ ...prev, ...p, active: true })), controller.signal);
            setFeedbackMessage({type: 'success', text: `Downloaded '${fileInfo.fileName}'`});
        } catch (err) { if (err.name !== 'AbortError') { setFeedbackMessage({type: 'error', text: `Download failed: ${err.message}`}); }
        } finally { setDownloadProgress({ active: false }); clearFeedback(); setAbortController(null); }
    };
    
    const handleFileDelete = async (itemToDelete) => {
        if (isBusy) return;
        
        const isFolder = itemToDelete.type === 'folder'; 
        
        const message = isFolder 
            ? `Are you sure you want to delete the folder "${itemToDelete.fileName}"? This will NOT delete its contents, which will become orphaned. This action is irreversible.`
            : `Are you sure you want to delete "${itemToDelete.fileName}"? This cannot be undone.`;

        if (!window.confirm(message)) return;
        
        setFeedbackMessage({ type: 'info', text: `Deleting '${itemToDelete.fileName}'...` });
        
        try {
            if (!isFolder) {
                await deleteTelegramMessages(config.botToken, config.channelId, itemToDelete.messages);
            }
            
            await db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/files`).doc(itemToDelete.id).delete();
            
            setFeedbackMessage({ type: 'success', text: `Successfully deleted '${itemToDelete.fileName}'.` });
        } catch (err) { 
            setFeedbackMessage({ type: 'error', text: `Failed to delete: ${err.message}` });
        } finally { 
            clearFeedback(); 
        }
    };

    const handleStartRename = (fileId, currentName) => { if (isBusy) return; setEditingFileId(fileId); setRenameValue(currentName); };
    const handleCancelRename = () => { setEditingFileId(null); setRenameValue(''); };
    const handleSaveRename = async (fileId, newName) => {
        const trimmedName = newName.trim();
        if (!trimmedName) { setFeedbackMessage({ type: 'error', text: 'Name cannot be empty.' }); clearFeedback(3000); return; }
        const originalItem = items.find(f => f.id === fileId);
        if (originalItem.fileName === trimmedName) { handleCancelRename(); return; }
        try {
            const fileRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/files`).doc(fileId);
            await fileRef.update({ fileName: trimmedName });
            setFeedbackMessage({ type: 'success', text: 'Renamed successfully!' });
        } catch (error) { setFeedbackMessage({ type: 'error', text: `Failed to rename: ${error.message}` });
        } finally { handleCancelRename(); clearFeedback(); }
    };
    const handleLogout = async () => { try { await auth.signOut(); } catch (err) { setFeedbackMessage({type: 'error', text: "Logout failed."}); clearFeedback(); }};
    const handleSaveSettings = async (newConfig) => {
        setIsSavingSettings(true);
        const configDocRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/config`).doc('telegram');
        try {
            await configDocRef.update({ botToken: newConfig.botToken, channelId: newConfig.channelId });
            setConfig(prev => ({...prev, ...newConfig}));
            setIsSettingsOpen(false);
            setFeedbackMessage({type: 'success', text: 'Settings updated successfully!'});
            clearFeedback();
        } catch (error) { throw error;
        } finally { setIsSavingSettings(false); }
    };

    const handleFolderClick = (folder) => {
        if (isBusy) return;
        setCurrentFolderId(folder.id);
        setFolderHierarchy(prev => [...prev, { id: folder.id, name: folder.fileName }]);
    };
    
    const handleBreadcrumbNavigate = (folderId, index) => {
        if (isBusy) return;
        setCurrentFolderId(folderId);
        setFolderHierarchy(prev => prev.slice(0, index + 1));
    };

    const handleCreateFolder = async () => {
        if (isBusy) return;
        const folderName = prompt("Enter new folder name:");
        if (!folderName || !folderName.trim()) {
            return;
        }
        
        const trimmedName = folderName.trim();
        setFeedbackMessage({type: 'info', text: `Creating folder '${trimmedName}'...`});

        try {
            const newFolderRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/files`).doc();
            const newFolderData = {
                id: newFolderRef.id,
                fileName: trimmedName,
                type: 'folder',
                parentId: currentFolderId,
                uploadedAt: firebase.firestore.Timestamp.now()
            };
            await newFolderRef.set(newFolderData);
            setFeedbackMessage({type: 'success', text: `Created folder '${trimmedName}'`});
        } catch (err) {
            setFeedbackMessage({type: 'error', text: `Failed to create folder: ${err.message}`});
        } finally {
            clearFeedback();
        }
    };

    if (isLoadingConfig) return <FullScreenLoader message="Loading Configuration..." />;
    if (configError) return (<div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4"><div className="w-full max-w-3xl bg-gray-800 rounded-xl shadow-2xl p-6"><div className="flex justify-between items-center mb-4"><h1 className="text-3xl font-bold text-indigo-400">DaemonClient</h1><button onClick={handleLogout} className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded-lg text-sm">Logout</button></div><div className="p-4 bg-red-700 text-red-100 rounded-lg"><h2 className="text-xl font-semibold mb-2">Configuration Error</h2><p>{configError}</p><p className="mt-2">Try logging out and back in.</p></div></div></div>);
    
    const filteredItems = items.filter(item => item.fileName.toLowerCase().includes(searchTerm.toLowerCase()));

    return (
        <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-4 font-sans">
            <div className="w-full max-w-3xl bg-gray-800 rounded-xl shadow-2xl p-6">
                <div className="flex justify-between items-center mb-4">
                    <h1 className="text-3xl font-bold text-indigo-400">DaemonClient</h1>
                    <div className="flex items-center space-x-4">
                        <button onClick={() => setIsSettingsOpen(true)} className="text-gray-400 hover:text-white" title="Settings"><SettingsIcon /></button>
                        <button onClick={handleLogout} className="bg-red-500 hover:bg-red-600 text-white py-2 px-4 rounded-lg text-sm">Logout</button>
                    </div>
                </div>
                <div className="bg-gray-700 p-4 rounded-lg mb-4">
                    <h2 className="text-xl font-semibold mb-2">Upload Files</h2>
                    <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" disabled={isBusy} multiple />
                    <button onClick={() => fileInputRef.current.click()} disabled={isBusy} className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-2 px-4 rounded-lg mt-2">
                        {isUploading ? 'Uploading...' : 'Choose Files to Upload'}
                    </button>
                </div>

                {isUploading && <ProgressBar {...uploadProgress} onCancel={handleCancelTransfer} />}

                <div className="bg-gray-700 p-4 rounded-lg mt-4">
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="text-xl font-semibold">Your Files</h2>
                        <div className="flex items-center space-x-2">
                            <button onClick={handleCreateFolder} disabled={isBusy} className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-1 px-2 rounded-lg text-sm flex items-center" title="Create Folder">
                                <CreateFolderIcon />
                                <span className="ml-1">New Folder</span>
                            </button>
                            <input type="text" placeholder="Search files..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full p-2 bg-gray-800 border border-gray-600 rounded-lg text-white text-sm" disabled={isBusy} />
                        </div>
                    </div>

                    <Breadcrumbs hierarchy={folderHierarchy} onNavigate={handleBreadcrumbNavigate} />
                    
                    <div className="mt-2 space-y-2 max-h-60 overflow-y-auto pr-2">
                        { isLoadingFiles ? (<p className="text-center text-gray-400 py-4">Loading...</p>) :
                          filteredItems.length > 0 ? (
                            filteredItems.map(item => (
                                <FileItem 
                                    key={item.id} 
                                    item={item} 
                                    isEditing={editingFileId === item.id} 
                                    renameValue={renameValue} 
                                    setRenameValue={setRenameValue} 
                                    onStartRename={handleStartRename} 
                                    onCancelRename={handleCancelRename} 
                                    onSaveRename={handleSaveRename} 
                                    onDownload={handleFileDownload} 
                                    onDelete={handleFileDelete}
                                    onFolderClick={handleFolderClick} 
                                    isBusy={isBusy && editingFileId !== item.id} 
                                />
                            ))
                          ) : (
                            <p className="text-center text-gray-400 py-4">This folder is empty.</p>
                          )
                        }
                    </div>
                </div>
                {isDownloading && <ProgressBar {...downloadProgress} onCancel={handleCancelTransfer} />}
                {feedbackMessage.text && <div className={`mt-4 p-3 rounded-lg text-sm text-center ${feedbackMessage.type === 'error' ? 'bg-red-900 text-red-200' : feedbackMessage.type === 'success' ? 'bg-green-900 text-green-200' : 'bg-blue-900 text-blue-200'}`}>{feedbackMessage.text}</div>}
                {!isUploading && !isDownloading && !feedbackMessage.text && <div className="h-12 mt-4"></div> }
            </div>
            {isSettingsOpen && config && <SettingsModal initialConfig={config} onSave={handleSaveSettings} onClose={() => setIsSettingsOpen(false)} isSaving={isSavingSettings} />}
        </div>
    );
};

const App = () => {
    const [user, setUser] = useState(null);
    const [appState, setAppState] = useState('loading'); 

    useEffect(() => {
        const unsubscribe = auth.onAuthStateChanged(async (currentUser) => {
            if (!currentUser) {
                setAppState(prevState => prevState === 'auth' ? 'auth' : 'landing');
                return;
            }
            setUser(currentUser);
            try {
                const configDocRef = db.collection(`artifacts/${appIdentifier}/users/${currentUser.uid}/config`).doc('telegram');
                const docSnap = await configDocRef.get();
                if (!docSnap.exists) {
                    setAppState('setup');
                } else {
                    const configData = docSnap.data();
                    if (configData.ownership_transferred) {
                        setAppState('dashboard');
                    } else {
                        setAppState('transfer');
                    }
                }
            } catch (error) { 
                console.error("[App] Error checking setup status:", error);
                setAppState('setup');
            }
        });
        return () => unsubscribe(); 
    }, []); 

    const handleLaunchApp = () => {
        setAppState('auth'); 
    };

    const handleSetupComplete = () => {
        setAppState('transfer');
    };
    
    const handleOwnershipConfirmed = () => {
        setAppState('dashboard');
    };

    if (appState === 'loading') return <FullScreenLoader message="Initializing App..." />;
    
    switch (appState) {
        case 'landing':
            return <LandingPage onLaunchApp={handleLaunchApp} />;
        case 'auth':
            return <AuthView />;
        case 'setup':
            return <SetupView onSetupComplete={handleSetupComplete} />;
        case 'transfer':
            return <OwnershipView onOwnershipConfirmed={handleOwnershipConfirmed} />;
        case 'dashboard':
            return <DashboardView />;
        default:
            return <AuthView />;
    }
};

export default App;