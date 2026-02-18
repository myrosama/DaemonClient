import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, Cloud, Lock, ChevronRight, Command, Server, Globe, Smartphone, Laptop } from 'lucide-react';
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import { deriveKey, encryptChunk, decryptChunk, generateSalt, generatePassword, bytesToBase64, base64ToBytes } from './crypto.js';

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

// ============================================================================
// --- CORE LOGIC & HELPER FUNCTIONS ---
// ============================================================================
const CHUNK_SIZE = 19 * 1024 * 1024;
const UPLOAD_RETRIES = 10;
const DOWNLOAD_RETRIES = 5;
const PROACTIVE_DELAY_MS = 1000;

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
    return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', s > 0 ? `${s}s` : (h === 0 && m === 0 ? '0s' : '')].filter(Boolean).join(' ') || '...';
}

// --- UPLOAD FUNCTION (With Proxy + ZKE Encryption) ---
async function uploadFile(file, botToken, channelId, onProgress, abortSignal, parentId, encryptionKey = null) {
    const totalParts = Math.ceil(file.size / CHUNK_SIZE);
    const uploadedMessageInfo = [];
    let uploadedBytes = 0;
    const startTime = Date.now();
    const proxyBaseUrl = "https://daemonclient-proxy.sadrikov49.workers.dev";
    const isEncrypted = encryptionKey !== null;

    for (let i = 0; i < totalParts; i++) {
        if (abortSignal.aborted) throw new Error("Upload was cancelled by the user.");
        const partNumber = i + 1;
        const rawChunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

        // Encrypt chunk if ZKE is enabled
        let chunkToUpload;
        if (isEncrypted) {
            const rawData = await rawChunk.arrayBuffer();
            const encryptedData = await encryptChunk(rawData, encryptionKey);
            chunkToUpload = new Blob([encryptedData]);
        } else {
            chunkToUpload = rawChunk;
        }
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
                formData.append('document', chunkToUpload, `${file.name}.part${String(partNumber).padStart(3, '0')}`);

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
                    uploadedBytes += rawChunk.size;
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
    onProgress({ percent: 100, status: `Upload complete!`, speed: '', eta: '' });

    return {
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        uploadedAt: firebase.firestore.Timestamp.now(),
        messages: uploadedMessageInfo,
        type: 'file',
        parentId: parentId,
        encrypted: isEncrypted
    };
}

// --- HYBRID DOWNLOAD FUNCTION (With ZKE Decryption) ---
async function downloadFile(fileInfo, botToken, onProgress, abortSignal, decryptionKey = null) {
    const { messages, fileName, fileSize, fileType, encrypted } = fileInfo;
    const shouldDecrypt = encrypted && decryptionKey !== null;
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const CONCURRENT_DOWNLOADS = isMobile ? 3 : 5;
    const CHUNK_SIZE = 19 * 1024 * 1024;

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

                const proxyBaseUrl = "https://daemonclient-proxy.sadrikov49.workers.dev"; // Your Cloudflare Proxy URL
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
                    let chunkData = await downloadPartWithRetry(partData);

                    // Decrypt chunk if file is encrypted and we have the key
                    if (shouldDecrypt) {
                        chunkData = await decryptChunk(chunkData, decryptionKey);
                    }

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
        for (let i = 0; i < CONCURRENT_DOWNLOADS; i++) {
            worker();
        }
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

// ============================================================================
// --- UI ICONS ---
// ============================================================================
const LoaderComponent = ({ small }) => <div className={`animate-spin rounded-full border-b-2 border-white ${small ? 'h-6 w-6' : 'h-10 w-10'}`}></div>;
const LogoComponent = () => <img src="/logo.png" alt="DaemonClient Logo" className="h-16 w-auto" />;
const FullScreenLoader = ({ message }) => <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white"><LoaderComponent /><p className="mt-4 text-lg">{message || "Loading Application..."}</p></div>;
const RenameIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>;
const FolderIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-indigo-300 w-5 h-5 mr-3 flex-shrink-0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>;
const FileIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 w-5 h-5 mr-3 flex-shrink-0"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>;
const CreateFolderIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>;
const SettingsIcon = () => <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 0 2.4l-.15.08a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l-.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1 0-2.4l.15.08a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>;
const ChevronIcon = ({ open }) => <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`inline-block ml-1 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9"></polyline></svg>;

// --- ICONS FOR LANDING PAGE ---
const CloudIconLP = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
    </svg>
);

const LockIconLP = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
);

const TerminalIconLP = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
);

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

// --- TERMS MODAL ---
const TermsModal = ({ onClose }) => {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 font-sans" onClick={onClose}>
            <div className="bg-gray-800 rounded-xl shadow-2xl p-8 w-full max-w-3xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <h2 className="text-2xl font-bold text-indigo-400 mb-4">Terms of Use for DaemonClient</h2>
                <div className="text-gray-300 space-y-4 text-sm">
                    <p className="text-gray-400">Last Updated: September 19, 2025</p>
                    <h3 className="font-semibold text-white pt-2">1. The Service</h3>
                    <p>DaemonClient ("the Service") is a software tool that allows users to leverage their personal Telegram account as a cloud storage backend. The Service is provided "as-is" without any warranties.</p>
                    <h3 className="font-semibold text-white pt-2">2. User Responsibility and Data Ownership</h3>
                    <p>You, the user, are solely responsible for the data you store using the Service. All files are stored in a private Telegram channel and managed by a Telegram bot to which you are given full ownership.</p>
                    <div className="text-center pt-4">
                        <button onClick={onClose} className="py-2 px-6 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-white">Close</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- AUTH VIEW (Login/Signup) ---
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
        if (!isLoginView && !hasAgreedToTerms) { setError("You must agree to the Terms of Use to create an account."); return; }
        if (!email || !password) { setError("Please enter email and password."); return; }
        setIsLoading(true); setError('');
        try {
            if (isLoginView) { await auth.signInWithEmailAndPassword(email, password); }
            else { await auth.createUserWithEmailAndPassword(email, password); }
        } catch (err) {
            setError(err.code.includes('auth/') ? "Invalid credentials or account state." : "An unexpected error occurred.");
        } finally { setIsLoading(false); }
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

// --- DASHBOARD VIEW ---
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
    const [feedbackMessage, setFeedbackMessage] = useState({ type: '', text: '' });
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSavingSettings, setIsSavingSettings] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [abortController, setAbortController] = useState(null);
    const [editingFileId, setEditingFileId] = useState(null);
    const [renameValue, setRenameValue] = useState('');

    const [uploadQueue, setUploadQueue] = useState([]);
    const [uploadBatchTotal, setUploadBatchTotal] = useState(0);

    // ZKE (Zero-Knowledge Encryption) State
    const [zkeEnabled, setZkeEnabled] = useState(true);
    const [zkeMode, setZkeMode] = useState('auto'); // 'auto' or 'custom'
    const [encryptionKey, setEncryptionKey] = useState(null);
    const [zkeLoading, setZkeLoading] = useState(true);

    const fileInputRef = useRef(null);
    const isUploading = uploadProgress.active;
    const isDownloading = downloadProgress.active;
    const isRenaming = editingFileId !== null;
    const isBusy = isUploading || isDownloading || isRenaming;

    // --- HELPER COMPONENTS (defined locally to DashboardView) ---
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
                        <p className="font-semibold text-white truncate w-32 md:w-52" title={item.fileName}>{item.fileName}</p>
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

    // --- EFFECT: FETCH CONFIG AND FILES (Uses currentFolderId) ---
    useEffect(() => {
        const currentAuthUser = auth.currentUser;
        if (!currentAuthUser) {
            setIsLoadingConfig(false); setIsLoadingFiles(false); setConfig(null); setItems([]);
            return;
        }

        const currentUserID = currentAuthUser.uid;

        // 1. Fetch Config
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

        // 2. Fetch ZKE Config (auto-load password + derive key)
        const zkeDocRef = db.collection(`artifacts/${appIdentifier}/users/${currentUserID}/config`).doc('zke');
        zkeDocRef.get().then(async (zkeSnap) => {
            if (zkeSnap.exists) {
                const zkeData = zkeSnap.data();
                if (zkeData.enabled && zkeData.password && zkeData.salt) {
                    try {
                        const salt = base64ToBytes(zkeData.salt);
                        const key = await deriveKey(zkeData.password, salt);
                        setEncryptionKey(key);
                        setZkeEnabled(true);
                        setZkeMode(zkeData.mode || 'auto');
                    } catch (err) {
                        console.error('Failed to derive ZKE key:', err);
                    }
                } else if (!zkeData.enabled) {
                    setZkeEnabled(false);
                }
            } else {
                // New user — auto-initialize ZKE with generated password
                try {
                    const password = generatePassword();
                    const salt = generateSalt();
                    const saltBase64 = bytesToBase64(salt);
                    const key = await deriveKey(password, salt);
                    setEncryptionKey(key);
                    setZkeEnabled(true);
                    setZkeMode('auto');
                    // Save to Firestore
                    await zkeDocRef.set({
                        enabled: true,
                        mode: 'auto',
                        password: password,
                        salt: saltBase64,
                        updatedAt: firebase.firestore.Timestamp.now()
                    });
                } catch (err) {
                    console.error('Failed to auto-initialize ZKE:', err);
                }
            }
        }).catch(err => {
            console.error('Failed to load ZKE config:', err);
        }).finally(() => {
            setZkeLoading(false);
        });

        // 2. Fetch Files & Folders for the currentFolderId
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
            setFeedbackMessage({ type: 'error', text: `Error loading files: ${error.message}` });
            setIsLoadingFiles(false);
            const timer = setTimeout(() => setFeedbackMessage({ type: '', text: '' }), 5000);
            return () => clearTimeout(timer);
        });

        return () => unsubscribe();

    }, [currentFolderId]);

    // --- EFFECT: PROCESS UPLOAD QUEUE (Uses currentFolderId) ---
    useEffect(() => {
        if (isUploading || uploadQueue.length === 0) return;

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
                    currentFolderId,
                    zkeEnabled ? encryptionKey : null  // Pass encryption key if ZKE enabled
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

    // --- HANDLERS ---
    const clearFeedback = (delay = 5000) => setTimeout(() => setFeedbackMessage({ type: '', text: '' }), delay);
    const handleCancelTransfer = () => { if (abortController) { abortController.abort(); setAbortController(null); setUploadQueue([]); setUploadProgress({ active: false }); setDownloadProgress({ active: false }); setFeedbackMessage({ type: 'info', text: 'Operation cancelled.' }); clearFeedback(); } };

    const handleFileUpload = (e) => {
        const newFiles = e.target.files;
        if (!newFiles.length) return;
        if (!config?.botToken) {
            setFeedbackMessage({ type: 'error', text: "Bot configuration not loaded." });
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
        if (fileInputRef.current) fileInputRef.current.value = "";
    };

    const handleFileDownload = async (fileInfo) => {
        if (!config?.botToken) { setFeedbackMessage({ type: 'error', text: "Bot configuration not loaded." }); clearFeedback(); return; }
        if (!fileInfo?.messages?.length) { setFeedbackMessage({ type: 'error', text: "File info incomplete." }); clearFeedback(); return; }
        const controller = new AbortController(); setAbortController(controller);
        setDownloadProgress({ active: true, percent: 0, status: 'Preparing download...', speed: '', eta: '' }); setFeedbackMessage({ type: '', text: '' });

        // Check if file is encrypted and we have the key
        if (fileInfo.encrypted && !encryptionKey) {
            setFeedbackMessage({ type: 'error', text: 'This file is encrypted. Enable ZKE in Settings and enter your password to decrypt.' });
            setDownloadProgress({ active: false });
            clearFeedback();
            return;
        }

        try {
            await downloadFile(
                fileInfo,
                config.botToken,
                (p) => setDownloadProgress(prev => ({ ...prev, ...p, active: true })),
                controller.signal,
                fileInfo.encrypted ? encryptionKey : null  // Pass decryption key if file is encrypted
            );
            setFeedbackMessage({ type: 'success', text: `Downloaded '${fileInfo.fileName}'` });
        } catch (err) {
            if (err.name !== 'AbortError') { setFeedbackMessage({ type: 'error', text: `Download failed: ${err.message}` }); }
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
        } catch (error) {
            setFeedbackMessage({ type: 'error', text: `Failed to rename: ${error.message}` });
        } finally { handleCancelRename(); clearFeedback(); }
    };
    const handleLogout = async () => {
        // Destroy encryption key from memory
        setEncryptionKey(null);
        setZkeEnabled(false);
        try { await auth.signOut(); } catch (err) { setFeedbackMessage({ type: 'error', text: "Logout failed." }); clearFeedback(); }
    };
    const handleSaveSettings = async (newConfig) => {
        setIsSavingSettings(true);
        const configDocRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/config`).doc('telegram');
        try {
            await configDocRef.update({ botToken: newConfig.botToken, channelId: newConfig.channelId });
            setConfig(prev => ({ ...prev, ...newConfig }));
            setIsSettingsOpen(false);
            setFeedbackMessage({ type: 'success', text: 'Settings updated successfully!' });
            clearFeedback();
        } catch (error) {
            throw error;
        } finally { setIsSavingSettings(false); }
    };

    // ZKE Enable/Disable Handler
    const handleZkeToggle = async (enabled, mode = 'auto', customPassword = null) => {
        const currentUserID = auth.currentUser.uid;
        const zkeDocRef = db.collection(`artifacts/${appIdentifier}/users/${currentUserID}/config`).doc('zke');

        if (enabled) {
            const password = mode === 'custom' ? customPassword : generatePassword();
            const salt = generateSalt();
            const saltBase64 = bytesToBase64(salt);

            const key = await deriveKey(password, salt);
            setEncryptionKey(key);
            setZkeEnabled(true);
            setZkeMode(mode);

            // Save to Firestore
            const zkeData = {
                enabled: true,
                mode: mode,
                salt: saltBase64,
                updatedAt: firebase.firestore.Timestamp.now()
            };

            // Only store password if auto mode
            if (mode === 'auto') {
                zkeData.password = password;
            } else {
                zkeData.password = null; // Don't store custom passwords
            }

            await zkeDocRef.set(zkeData, { merge: true });
        } else {
            // Disable ZKE
            setEncryptionKey(null);
            setZkeEnabled(false);
            await zkeDocRef.set({ enabled: false, password: null, updatedAt: firebase.firestore.Timestamp.now() }, { merge: true });
        }
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
        setFeedbackMessage({ type: 'info', text: `Creating folder '${trimmedName}'...` });

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
            setFeedbackMessage({ type: 'success', text: `Created folder '${trimmedName}'` });
        } catch (err) {
            setFeedbackMessage({ type: 'error', text: `Failed to create folder: ${err.message}` });
        } finally {
            clearFeedback();
        }
    };

    const SettingsModal = ({ initialConfig, onSave, onClose, isSaving, zkeEnabled, zkeMode, onZkeToggle }) => {
        const [botToken, setBotToken] = useState(initialConfig.botToken || '');
        const [channelId, setChannelId] = useState(initialConfig.channelId || '');
        const [localZkeEnabled, setLocalZkeEnabled] = useState(zkeEnabled);
        const [localZkeMode, setLocalZkeMode] = useState(zkeMode);
        const [customPassword, setCustomPassword] = useState('');
        const [confirmPassword, setConfirmPassword] = useState('');
        const [error, setError] = useState('');
        const [isProcessing, setIsProcessing] = useState(false);

        const handleSave = async () => {
            if (!botToken.trim() || !channelId.trim()) { setError("Bot Token and Channel ID cannot be empty."); return; }

            // Validate custom password if switching to custom mode
            if (localZkeEnabled && localZkeMode === 'custom') {
                if (!customPassword.trim()) { setError("Custom password is required."); return; }
                if (customPassword !== confirmPassword) { setError("Passwords don't match."); return; }
                if (customPassword.length < 8) { setError("Password must be at least 8 characters."); return; }
            }

            setError('');
            setIsProcessing(true);

            try {
                // Handle ZKE state change
                if (localZkeEnabled !== zkeEnabled || localZkeMode !== zkeMode) {
                    await onZkeToggle(
                        localZkeEnabled,
                        localZkeMode,
                        localZkeMode === 'custom' ? customPassword : null
                    );
                }

                await onSave({ botToken, channelId });
            } catch (err) {
                setError(`Save failed: ${err.message}`);
            } finally {
                setIsProcessing(false);
            }
        };

        return (
            <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 font-sans">
                <div className="bg-gray-800 rounded-xl shadow-2xl p-8 w-full max-w-lg max-h-[90vh] overflow-y-auto">
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

                        {/* ZKE Section */}
                        <div className="border-t border-gray-700 pt-4 mt-4">
                            <div className="flex items-center justify-between mb-3">
                                <div>
                                    <h3 className="text-lg font-semibold text-green-400 flex items-center gap-2">
                                        🔐 ZKE Encryption
                                    </h3>
                                    <p className="text-xs text-gray-400">AES-256-GCM • Client-side only</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setLocalZkeEnabled(!localZkeEnabled)}
                                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${localZkeEnabled ? 'bg-green-600' : 'bg-gray-600'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${localZkeEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                                </button>
                            </div>

                            {localZkeEnabled && (
                                <div className="space-y-3 bg-gray-900/50 p-3 rounded-lg">
                                    <div className="text-xs text-green-400 bg-green-400/10 p-2 rounded">
                                        ✅ New uploads will be encrypted before reaching Telegram.
                                    </div>

                                    {/* Mode Selection */}
                                    <div className="space-y-2">
                                        <label
                                            className={`flex items-center gap-3 p-2 rounded cursor-pointer border ${localZkeMode === 'auto' ? 'border-green-600 bg-green-600/10' : 'border-gray-700 hover:border-gray-500'}`}
                                            onClick={() => setLocalZkeMode('auto')}
                                        >
                                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${localZkeMode === 'auto' ? 'border-green-500' : 'border-gray-500'}`}>
                                                {localZkeMode === 'auto' && <div className="w-2 h-2 rounded-full bg-green-500" />}
                                            </div>
                                            <div>
                                                <p className="text-sm text-white font-medium">Automatic <span className="text-xs text-gray-400">(Recommended)</span></p>
                                                <p className="text-xs text-gray-400">Password auto-generated & stored securely. No hassle.</p>
                                            </div>
                                        </label>
                                        <label
                                            className={`flex items-center gap-3 p-2 rounded cursor-pointer border ${localZkeMode === 'custom' ? 'border-yellow-600 bg-yellow-600/10' : 'border-gray-700 hover:border-gray-500'}`}
                                            onClick={() => setLocalZkeMode('custom')}
                                        >
                                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${localZkeMode === 'custom' ? 'border-yellow-500' : 'border-gray-500'}`}>
                                                {localZkeMode === 'custom' && <div className="w-2 h-2 rounded-full bg-yellow-500" />}
                                            </div>
                                            <div>
                                                <p className="text-sm text-white font-medium">Custom Password <span className="text-xs text-gray-400">(Advanced)</span></p>
                                                <p className="text-xs text-gray-400">True zero-knowledge. We never store your password.</p>
                                            </div>
                                        </label>
                                    </div>

                                    {/* Custom Password Fields */}
                                    {localZkeMode === 'custom' && (
                                        <div className="space-y-3 mt-2">
                                            <div>
                                                <label htmlFor="zke-password" className="block text-sm font-medium text-gray-300 mb-1">Encryption Password</label>
                                                <input
                                                    id="zke-password"
                                                    type="password"
                                                    value={customPassword}
                                                    onChange={(e) => setCustomPassword(e.target.value)}
                                                    placeholder="Min 8 characters"
                                                    className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white"
                                                />
                                            </div>
                                            <div>
                                                <label htmlFor="zke-confirm" className="block text-sm font-medium text-gray-300 mb-1">Confirm Password</label>
                                                <input
                                                    id="zke-confirm"
                                                    type="password"
                                                    value={confirmPassword}
                                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                                    placeholder="Re-enter password"
                                                    className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white"
                                                />
                                            </div>
                                            <div className="text-xs text-red-400 bg-red-400/10 p-2 rounded">
                                                ⚠️ <strong>Warning:</strong> We will NOT store this password. If you forget it, your encrypted files are permanently lost. Nobody can recover them.
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {error && <p className="text-red-400 text-sm text-center py-1">{error}</p>}
                    </div>
                    <div className="flex justify-end space-x-4 mt-6">
                        <button onClick={onClose} disabled={isSaving || isProcessing} className="py-2 px-4 bg-gray-600 hover:bg-gray-500 rounded-lg text-white">Cancel</button>
                        <button onClick={handleSave} disabled={isSaving || isProcessing} className="py-2 px-6 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-white flex items-center justify-center min-w-24">
                            {(isSaving || isProcessing) ? <LoaderComponent small={true} /> : 'Save'}
                        </button>
                    </div>
                </div>
            </div>
        );
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
                        {isLoadingFiles ? (<p className="text-center text-gray-400 py-4">Loading...</p>) :
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
                {!isUploading && !isDownloading && !feedbackMessage.text && <div className="h-12 mt-4"></div>}
            </div>
            {isSettingsOpen && config && <SettingsModal
                initialConfig={config}
                onSave={handleSaveSettings}
                onClose={() => setIsSettingsOpen(false)}
                isSaving={isSavingSettings}
                zkeEnabled={zkeEnabled}
                zkeMode={zkeMode}
                onZkeToggle={handleZkeToggle}
            />}
        </div>
    );
};

// --- SETUP VIEW ---
const SetupView = ({ onSetupComplete }) => {
    const [showManualForm, setShowManualForm] = useState(false);
    const [statusMessage, setStatusMessage] = useState('');
    const [botToken, setBotToken] = useState('');
    const [channelId, setChannelId] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleStartAutomatedSetup = async () => {
        setStatusMessage('Initiating secure setup... This may take a minute.');
        setError('');
        setIsLoading(true);
        try {
            const response = await fetch('https://daemonclient.onrender.com/startSetup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { uid: auth.currentUser.uid, email: auth.currentUser.email, } })
            });
            const result = await response.json();
            if (!response.ok) { throw new Error(result.error?.message || 'The setup service returned an unspecified error.'); }
            setStatusMessage("Finalizing configuration...");
            const configDocRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/config`).doc('telegram');
            let attempts = 0;
            const maxAttempts = 5;
            while (attempts < maxAttempts) {
                const docSnap = await configDocRef.get();
                if (docSnap.exists && docSnap.data().botToken) {
                    setStatusMessage('Configuration saved! Proceeding to final step...');
                    onSetupComplete();
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }
            throw new Error("Could not verify configuration after setup. Please try again.");
        } catch (err) {
            console.error("Error during setup process:", err);
            setStatusMessage('');
            if (err.message.includes('Failed to fetch')) {
                setError(`Could not connect to the setup service. Please try again later.`);
            } else {
                setError(`An unexpected error occurred. Please try again or contact support.`);
            }
        } finally {
            setIsLoading(false);
        }
    };

    const handleSaveManualSetup = async () => {
        if (!botToken.trim() || !channelId.trim()) { setError("Bot Token and Channel ID are required."); return; }
        setIsLoading(true); setError('');
        try {
            const configDocRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/config`).doc('telegram');
            await configDocRef.set({ botToken: botToken.trim(), channelId: channelId.trim(), setupTimestamp: firebase.firestore.FieldValue.serverTimestamp() });
            onSetupComplete();
        } catch (err) { setError(`Save failed: ${err.message}`); }
        finally { setIsLoading(false); }
    };
    const handleLogout = async () => { try { await auth.signOut(); } catch (err) { /* silent fail */ } };
    useEffect(() => {
        const uid = auth.currentUser?.uid;
        if (!uid) return;
        const unsubscribe = db.collection(`artifacts/${appIdentifier}/users/${uid}/config`).doc('telegram')
            .onSnapshot((doc) => {
                if (doc.exists && doc.data().botToken) {
                    setStatusMessage('Setup complete! Redirecting to your dashboard...');
                    setTimeout(() => onSetupComplete(), 1500);
                }
            });
        return () => unsubscribe();
    }, [onSetupComplete]);
    const AutomatedSetupPanel = () => (
        <div className="bg-gray-900 border-2 border-indigo-500 rounded-lg p-6 relative">
            <span className="absolute top-0 right-4 -mt-3 bg-indigo-500 text-white text-xs font-bold px-3 py-1 rounded-full">Recommended</span>
            <h2 className="text-xl font-semibold text-white">Automated Setup</h2>
            <p className="text-gray-400 mt-2 text-sm">The easiest way to get started. We'll automatically create and configure a private bot and channel for you.</p>
            <button onClick={handleStartAutomatedSetup} disabled={isLoading || !!statusMessage} className="mt-6 w-full bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center text-lg disabled:bg-gray-600 disabled:cursor-not-allowed">
                {isLoading ? <LoaderComponent /> : 'Create My Secure Storage'}
            </button>
        </div>
    );
    const ManualSetupPanel = () => (
        <div className="bg-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-semibold text-white">Manual Setup</h2>
            <p className="text-gray-400 mt-2 text-sm">For advanced users who want to use their own existing bot and channel.</p>
            <button onClick={() => setShowManualForm(true)} className="mt-4 w-full bg-gray-600 hover:bg-gray-500 text-white font-bold py-2 px-4 rounded-lg flex items-center justify-center">Enter Credentials Manually</button>
        </div>
    );
    const ManualSetupForm = () => (
        <div className="mt-8 animate-fade-in">
            <h2 className="text-xl font-semibold text-center text-white mb-4">Enter Your Credentials</h2>
            <div className="space-y-6">
                <div>
                    <label htmlFor="botToken-setup" className="block text-sm font-medium text-gray-300 mb-1">Telegram Bot Token</label>
                    <input id="botToken-setup" type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} className="w-full p-3 bg-gray-600 border border-gray-500 rounded-lg text-white" placeholder="From @BotFather" />
                </div>
                <div>
                    <label htmlFor="channelId-setup" className="block text-sm font-medium text-gray-300 mb-1">Private Channel ID</label>
                    <input id="channelId-setup" type="text" value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-full p-3 bg-gray-600 border border-gray-500 rounded-lg text-white" placeholder="From @userinfobot" />
                </div>
                {error && <p className="text-red-400 text-sm text-center py-2">{error}</p>}
                <button onClick={handleSaveManualSetup} disabled={isLoading} className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:bg-indigo-800 text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center text-lg">
                    {isLoading ? <LoaderComponent small={true} /> : 'Save & Continue'}
                </button>
                <button onClick={() => setShowManualForm(false)} className="w-full text-center text-gray-400 hover:text-white text-sm mt-4">Back to setup options</button>
            </div>
        </div>
    );
    const StatusBar = ({ message }) => (
        <div className="mt-8 p-4 bg-gray-900 rounded-lg flex items-center justify-center animate-fade-in">
            <LoaderComponent small={true} />
            <p className="ml-4 text-indigo-300">{message}</p>
        </div>
    );
    return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4 font-sans">
            <div className="w-full max-w-2xl">
                <div className="bg-gray-800 rounded-xl shadow-2xl p-6 md:p-8 relative overflow-hidden">
                    <div className="text-center mb-8">
                        <h1 className="text-3xl font-bold text-indigo-400">One-Time Setup</h1>
                        <p className="text-gray-400 mt-2">Let's create your private, secure storage.</p>
                    </div>
                    {showManualForm ? <ManualSetupForm /> : (<div className="space-y-8"><AutomatedSetupPanel /><ManualSetupPanel /></div>)}
                    {statusMessage && <StatusBar message={statusMessage} />}
                    {error && !statusMessage && <p className="text-red-400 text-center mt-4">{error}</p>}
                </div>
                <div className="text-center mt-6">
                    <button onClick={handleLogout} className="text-sm text-gray-500 hover:text-gray-300">Logout</button>
                </div>
            </div>
        </div>
    );
};

// --- OWNERSHIP VIEW ---
const OwnershipView = ({ onOwnershipConfirmed }) => {
    const [config, setConfig] = useState(null);
    const [step, setStep] = useState(1);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    const [countdown, setCountdown] = useState(10);
    const [isButtonDisabled, setIsButtonDisabled] = useState(true);
    const [hasClickedLink, setHasClickedLink] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [transferStatus, setTransferStatus] = useState(null);

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const configDocRef = db.collection(`artifacts/${appIdentifier}/users/${auth.currentUser.uid}/config`).doc('telegram');
                const docSnap = await configDocRef.get();
                if (docSnap.exists) {
                    setConfig(docSnap.data());
                } else {
                    setError("Could not find your configuration. Please try the setup again.");
                }
            } catch (err) {
                setError("Error fetching configuration: " + err.message);
            } finally {
                setIsLoading(false);
            }
        };
        fetchConfig();
    }, []);
    useEffect(() => {
        if (isLoading) return;
        setIsButtonDisabled(true);
        setCountdown(10);
        if (hasClickedLink) {
            const interval = setInterval(() => {
                setCountdown(prev => {
                    if (prev <= 1) {
                        clearInterval(interval);
                        setIsButtonDisabled(false);
                        return 0;
                    }
                    return prev - 1;
                });
            }, 1000);
            return () => clearInterval(interval);
        }
    }, [step, hasClickedLink, isLoading]);
    const handleLinkClicked = () => { if (!hasClickedLink) { setHasClickedLink(true); } };
    const handleNextStep = () => { setStep(2); setHasClickedLink(false); };
    const handleFinalize = async () => {
        setIsProcessing(true);
        setStep(3);
        setError('');
        setTransferStatus({
            bot: { status: 'pending', message: 'Verifying user and transferring bot ownership...' },
            channel: { status: 'pending', message: 'Attempting to transfer channel ownership...' }
        });
        try {
            const response = await fetch('https://daemonclient.onrender.com/finalizeTransfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: { uid: auth.currentUser.uid } })
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error?.message || 'The server returned an unspecified error.');
            }
            setTransferStatus({
                bot: { status: result.bot_transfer_status, message: result.bot_transfer_message },
                channel: { status: result.channel_transfer_status, message: result.channel_transfer_message }
            });
            setTimeout(() => onOwnershipConfirmed(), 5000);
        } catch (err) {
            setError(`A critical error occurred: ${err.message}`);
            setStep(2);
            setIsProcessing(false);
            setHasClickedLink(false);
        }
    };
    const StatusItem = ({ status, message }) => {
        const icon = status === 'pending' ? <LoaderComponent small={true} /> :
            status === 'success' ? <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-400"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> :
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-400"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>;
        const textColor = status === 'success' ? 'text-green-300' : status === 'failed' ? 'text-red-300' : 'text-gray-300';
        return <li className="flex items-start space-x-3 py-2"><div className="flex-shrink-0 mt-1">{icon}</div><p className={`${textColor} text-sm`}>{message}</p></li>;
    };
    if (isLoading) {
        return <FullScreenLoader message="Loading your bot and channel details..." />;
    }
    const renderStepContent = () => {
        switch (step) {
            case 1:
                return (
                    <div className="space-y-6 text-center">
                        <h1 className="text-3xl font-bold text-indigo-400">Final Step (1/2): Start Your Bot</h1>
                        <p className="text-gray-400">This is required by Telegram to transfer ownership. Click the link, press START in Telegram, then come back here.</p>
                        <a
                            href={config ? `https://t.me/${config.botUsername}` : '#'}
                            target="_blank"
                            onClick={handleLinkClicked}
                            className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg text-lg"
                        >
                            {config ? `Open Bot: @${config.botUsername}` : <LoaderComponent small={true} />}
                        </a>
                        <button onClick={handleNextStep} disabled={isButtonDisabled} className="w-full max-w-xs mx-auto bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center text-lg">
                            {isButtonDisabled ? `Next Step (${countdown}s)` : 'Next Step'}
                        </button>
                    </div>
                );
            case 2:
                return (
                    <div className="space-y-6 text-center">
                        <h1 className="text-3xl font-bold text-indigo-400">Final Step (2/2): Join Your Channel</h1>
                        <p className="text-gray-400">This allows us to securely identify you as the owner. Click the link to join, then come back and finalize.</p>
                        <a
                            href={config ? config.invite_link : '#'}
                            target="_blank"
                            onClick={handleLinkClicked}
                            className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg text-lg"
                        >
                            {config ? 'Join Secure Channel' : <LoaderComponent small={true} />}
                        </a>
                        <button onClick={handleFinalize} disabled={isButtonDisabled} className="w-full max-w-xs mx-auto bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center text-lg">
                            {isButtonDisabled ? `Finalize (${countdown}s)` : 'Finalize Transfer'}
                        </button>
                    </div>
                );
            case 3:
                return (
                    <div>
                        <h1 className="text-3xl font-bold text-indigo-400 text-center mb-4">Finalizing Setup...</h1>
                        <ul className="space-y-2 bg-gray-900 p-4 rounded-lg">
                            <StatusItem status={transferStatus.bot.status} message={transferStatus.bot.message} />
                            <StatusItem status={transferStatus.channel.status} message={transferStatus.channel.message} />
                        </ul>
                    </div>
                );
            default:
                return null;
        }
    };
    return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4 font-sans">
            <div className="w-full max-w-xl bg-gray-800 rounded-xl shadow-2xl p-6 md:p-8">
                {renderStepContent()}
                {error && <p className="text-red-400 text-sm text-center mt-4">{error}</p>}
            </div>
        </div>
    );
};

// ============================================================================
// --- VISUAL COMPONENTS (Backgrounds, 3D Core, Animations) ---
// ============================================================================

const HeroBackground = () => {
    const particles = [...Array(15)].map((_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.random() * 3 + 1,
        duration: Math.random() * 10 + 10,
    }));

    return (
        <div className="absolute inset-0 overflow-hidden pointer-events-none -z-10">
            <div className="absolute inset-0 bg-[#05080F]" />
            <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]" />
            {particles.map((p) => (
                <motion.div
                    key={p.id}
                    className="absolute rounded-full bg-indigo-500/20 blur-[1px]"
                    style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size }}
                    animate={{ y: [0, -40, 0], opacity: [0.2, 0.5, 0.2] }}
                    transition={{ duration: p.duration, repeat: Infinity, ease: "easeInOut" }}
                />
            ))}
            <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-[100px]" />
            <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[100px]" />
        </div>
    );
};

const SecureCloudCore = () => {
    return (
        <div className="relative w-full h-[500px] md:h-[700px] flex items-center justify-center perspective-1000">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(99,102,241,0.15)_0%,_transparent_60%)] blur-3xl" />

            {/* Outer Ring - Keeps slow rotation for atmosphere */}
            <motion.div
                animate={{ rotate: [0, 360] }}
                transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
                className="absolute w-[450px] h-[450px] md:w-[650px] md:h-[650px] rounded-full border border-indigo-500/10 border-dashed"
            >
                <div className="absolute top-0 left-1/2 w-3 h-3 -ml-1.5 -mt-1.5 bg-indigo-500 rounded-full blur-[1px] shadow-[0_0_10px_#6366f1]" />
            </motion.div>

            {/* Inner Ring - Keeps slow counter-rotation */}
            <motion.div
                animate={{ rotate: [360, 0] }}
                transition={{ duration: 40, repeat: Infinity, ease: "linear" }}
                className="absolute w-[320px] h-[320px] md:w-[500px] md:h-[500px] rounded-full border border-cyan-500/20"
                style={{ borderTopColor: "rgba(6,182,212,0.6)", borderRightColor: "transparent", borderBottomColor: "transparent", borderLeftColor: "transparent", borderWidth: "1px" }}
            >
                <div className="absolute bottom-[14%] right-[14%] w-2 h-2 bg-cyan-400 rounded-full shadow-[0_0_8px_#22d3ee]" />
            </motion.div>

            {/* Core Sphere */}
            <motion.div
                // KEEPING the Hover Animation
                animate={{ y: [0, -20, 0] }}
                transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
                className="relative z-10"
            >
                <div className="relative w-48 h-48 md:w-64 md:h-64 bg-[#0F131F]/80 backdrop-blur-xl border border-indigo-500/30 rounded-full flex items-center justify-center shadow-[0_0_80px_rgba(99,102,241,0.25)] overflow-hidden">

                    {/* CLEAN INTERIOR: No scanning lines, no rotating gradients. */}

                    <div className="relative z-20">
                        <img
                            src="/logo.png"
                            alt="Core"
                            className="w-24 h-24 md:w-32 md:h-32 object-contain drop-shadow-[0_0_25px_rgba(99,102,241,0.5)]"
                        />
                    </div>

                    {/* Subtle glass reflection */}
                    <div className="absolute inset-0 rounded-full bg-gradient-to-b from-white/10 to-transparent pointer-events-none" />
                </div>
            </motion.div>
        </div>
    );
};

const TerminalDemo = () => {
    const [text, setText] = useState('');
    const fullText = "> daemon upload secret_plans.pdf\n[+] Encrypting file...\n[+] Chunking into 19MB parts...\n[+] Uploading to secure channel...\n[+] File 'secret_plans.pdf' registered.\n> ";
    useEffect(() => {
        let i = 0; let mounted = true;
        const typeWriter = () => {
            if (!mounted) return;
            if (i <= fullText.length) { setText(fullText.slice(0, i)); i++; setTimeout(typeWriter, 30); }
            else { setTimeout(() => { if (mounted) { i = 0; setText(''); typeWriter(); } }, 4000); }
        };
        typeWriter();
        return () => { mounted = false; };
    }, []);
    return (
        <div className="bg-[#0F131F] rounded-xl border border-gray-800 p-6 font-mono text-sm shadow-2xl w-full h-64 flex flex-col relative overflow-hidden group">
            <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] z-10 pointer-events-none bg-[length:100%_4px,3px_100%]" />
            <div className="flex gap-2 mb-4 border-b border-gray-800 pb-2 z-20">
                <div className="w-3 h-3 rounded-full bg-red-500/50" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
                <div className="w-3 h-3 rounded-full bg-green-500/50" />
                <span className="ml-auto text-xs text-gray-600">bash</span>
            </div>
            <div className="text-gray-300 whitespace-pre-line z-20">{text}<span className="animate-pulse inline-block w-2 h-4 bg-indigo-500 align-middle ml-1" /></div>
        </div>
    );
};

// ============================================================================
// --- LANDING PAGE COMPONENT ---
// ============================================================================

const LandingPage = ({ onLaunchApp = () => console.log("Launch") }) => {
    const [activeFeature, setActiveFeature] = useState(0);
    const [activeDownload, setActiveDownload] = useState(null);

    useEffect(() => {
        const interval = setInterval(() => { setActiveFeature((prev) => (prev + 1) % 3); }, 5000);
        return () => clearInterval(interval);
    }, []);

    const Counter = ({ from, to, suffix = "" }) => {
        const [count, setCount] = useState(from);
        useEffect(() => {
            let startTime; const duration = 2000;
            const animate = (timestamp) => {
                if (!startTime) startTime = timestamp;
                const progress = Math.min((timestamp - startTime) / duration, 1);
                setCount(progress * (to - from) + from);
                if (progress < 1) requestAnimationFrame(animate);
            };
            requestAnimationFrame(animate);
        }, [from, to]);
        const display = to % 1 !== 0 ? count.toFixed(1) : Math.floor(count).toLocaleString();
        return <span>{display}{suffix}</span>;
    };

    const InfinityVisual = () => (
        <div className="relative w-full h-64 flex items-center justify-center bg-[#0F131F] rounded-xl border border-gray-800 overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 to-transparent"></div>
            <motion.div animate={{ rotate: 360 }} transition={{ duration: 20, repeat: Infinity, ease: "linear" }} className="w-32 h-32 rounded-full border-2 border-dashed border-indigo-500/30" />
            <motion.div animate={{ rotate: -360 }} transition={{ duration: 15, repeat: Infinity, ease: "linear" }} className="absolute w-48 h-48 rounded-full border border-cyan-500/20" />
            <div className="absolute text-7xl font-bold text-white/20 select-none">∞</div>
            <motion.div animate={{ scale: [1, 1.5, 1], opacity: [0.3, 0.6, 0.3] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }} className="absolute w-24 h-24 bg-indigo-500/20 rounded-full blur-2xl" />
        </div>
    );

    const SecurityVisual = () => (
        <div className="relative w-full h-64 flex items-center justify-center bg-[#0F131F] rounded-xl border border-gray-800 overflow-hidden">
            <div className="grid grid-cols-6 gap-4 opacity-20 rotate-12 scale-150">
                {[...Array(24)].map((_, i) => (
                    <motion.div key={i} initial={{ opacity: 0.2 }} animate={{ opacity: [0.2, 0.8, 0.2] }} transition={{ duration: Math.random() * 2 + 1, repeat: Infinity }} className="w-12 h-2 rounded bg-indigo-500" />
                ))}
            </div>
            <div className="absolute inset-0 flex items-center justify-center z-10">
                <div className="p-5 bg-[#0B0F19] rounded-full border border-indigo-500/50 shadow-[0_0_40px_rgba(99,102,241,0.4)]">
                    <Lock className="w-8 h-8 text-indigo-400" />
                </div>
            </div>
        </div>
    );

    const AlgoStep = ({ title, description, visual }) => (
        <div className="bg-[#0F131F] p-8 rounded-2xl border border-gray-800 hover:border-indigo-500/30 transition-all flex flex-col h-full hover:bg-[#131725] group">
            <div className="h-40 flex items-center justify-center mb-6 bg-black/20 rounded-xl border border-gray-800/50 overflow-hidden relative group-hover:border-indigo-500/20 transition-colors">{visual}</div>
            <h4 className="text-xl font-bold text-white mb-2 group-hover:text-indigo-400 transition-colors">{title}</h4>
            <p className="text-gray-400 text-sm leading-relaxed">{description}</p>
        </div>
    );

    const StepCard = ({ number, title, description }) => (
        <div className="relative flex flex-col items-center text-center p-6 z-10 group">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center text-xl font-bold text-white mb-6 shadow-lg shadow-indigo-900/50 group-hover:scale-110 transition-transform duration-300">{number}</div>
            <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
            <p className="text-gray-400 text-sm leading-relaxed">{description}</p>
        </div>
    );

    const DownloadOption = ({ title, icon, status, description, buttonText, onClick, isActive, primary }) => (
        <div className={`p-8 rounded-2xl border transition-all duration-300 cursor-pointer hover:-translate-y-1 flex flex-col h-full group ${isActive ? 'border-indigo-500 bg-indigo-900/10 shadow-lg shadow-indigo-500/20' : primary ? 'border-indigo-500/50 bg-indigo-900/5 hover:bg-indigo-900/10' : 'border-gray-800 bg-[#0F131F] hover:border-gray-700'}`} onClick={onClick}>
            <div className="flex items-center justify-between mb-6">
                <h3 className="text-lg font-bold text-white flex items-center gap-3 group-hover:text-indigo-300 transition-colors">{icon} {title}</h3>
                {status && <span className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border ${status === 'Live' ? 'bg-green-900/30 text-green-400 border-green-800' : 'bg-yellow-900/30 text-yellow-400 border-yellow-800'}`}>{status}</span>}
            </div>
            <p className="text-gray-400 text-sm mb-8 flex-grow leading-relaxed">{description}</p>
            <button className={`w-full py-3 px-6 rounded-lg text-center font-bold tracking-wide transition-all text-sm ${primary ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/25' : 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white'}`}>{buttonText}</button>
        </div>
    );

    const features = [
        { title: "Daemon CLI", desc: "Automate backups. Scriptable sync. Headless power.", icon: <Terminal className="w-5 h-5" />, visual: <TerminalDemo /> },
        { title: "Infinite Scale", desc: "Store 100TB without fees. No throttling. Just raw storage.", icon: <Cloud className="w-5 h-5" />, visual: <InfinityVisual /> },
        { title: "Open Source", desc: "Audit the code. Host it yourself. You own the platform.", icon: <Lock className="w-5 h-5" />, visual: <SecurityVisual /> }
    ];

    return (
        <div className="min-h-screen bg-[#05080F] text-white font-sans selection:bg-indigo-500 selection:text-white overflow-x-hidden scroll-smooth">
            {/* Navbar */}
            <nav className="fixed top-0 w-full z-50 bg-[#05080F]/80 backdrop-blur-md border-b border-gray-800/50">
                <div className="container mx-auto px-6 py-4 flex justify-between items-center">
                    <div className="flex items-center gap-3 cursor-pointer" onClick={() => window.scrollTo(0, 0)}>
                        {/* LOGO UPDATE START */}
                        <img src="/logo.png" alt="Logo" className="w-8 h-8 object-contain" />
                        {/* LOGO UPDATE END */}
                        <span className="text-lg font-bold tracking-tight">DaemonClient</span>
                    </div>
                    <div className="hidden md:flex items-center gap-8">
                        <a href="#philosophy" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Philosophy</a>
                        <a href="#protocol" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Protocol</a>
                        <a href="#features" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Power Users</a>
                        <a href="https://github.com/myrosama/DaemonClient" target="_blank" rel="noreferrer" className="text-gray-400 hover:text-white transition-colors">GitHub</a>
                        <button onClick={onLaunchApp} className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-indigo-900/20 hover:-translate-y-0.5">Launch App</button>
                    </div>
                    <div className="md:hidden"><button onClick={onLaunchApp} className="text-indigo-500 font-semibold">Launch App</button></div>
                </div>
            </nav>

            <header className="container mx-auto px-6 pt-28 pb-16 md:pt-40 md:pb-24 flex flex-col md:flex-row items-center relative">
                <HeroBackground />
                <div className="md:w-1/2 md:pr-12 z-10 relative">
                    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
                        <div className="inline-flex items-center gap-2 py-1 px-3 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-bold uppercase tracking-wider mb-6">
                            <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span></span>
                            Public Beta Live
                        </div>
                        <h1 className="text-4xl md:text-7xl font-bold leading-tight mb-6 tracking-tight">
                            The Cloud is Broken.<br /><span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">We Fixed It.</span>
                        </h1>
                        <p className="text-lg text-gray-400 mb-10 leading-relaxed max-w-lg">Traditional cloud storage charges you rent for digital space. We reverse-engineered the concept to give you <b>infinite bandwidth</b> and <b>zero costs</b> by owning the infrastructure.</p>
                        <div className="flex flex-col sm:flex-row gap-4 mb-12">
                            <button onClick={onLaunchApp} className="bg-white text-black hover:bg-gray-100 px-8 py-3.5 rounded-xl font-bold text-lg transition-all shadow-[0_0_20px_rgba(255,255,255,0.15)] hover:shadow-[0_0_30px_rgba(255,255,255,0.25)] hover:-translate-y-1 flex items-center justify-center gap-2">Start Uploading <ChevronRight className="w-5 h-5" /></button>
                            <a href="#download" className="bg-[#1A1F2E] hover:bg-gray-800 px-8 py-3.5 rounded-xl font-bold text-lg transition-all border border-gray-700 hover:border-gray-500 flex items-center justify-center gap-2 group text-gray-200"><Terminal className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors" /><span>Download CLI</span></a>
                        </div>
                    </motion.div>
                </div>
                <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1, delay: 0.2 }} className="w-full md:w-1/2 mt-12 md:mt-0 h-[400px] md:h-[600px] flex items-center justify-center relative z-0">
                    <SecureCloudCore />
                </motion.div>
            </header>

            <section className="py-10 border-y border-gray-800/50 bg-[#0B0F19]/30 backdrop-blur-sm relative z-20">
                <div className="container mx-auto px-6">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                        <div className="p-6 rounded-2xl bg-[#0F131F]/50 border border-gray-800 text-center hover:border-indigo-500/30 transition-colors backdrop-blur-sm"><div className="text-3xl font-bold text-white mb-1 font-mono"><Counter from={0} to={99.9} suffix="%" /></div><div className="text-xs uppercase tracking-widest text-gray-500 font-bold">Uptime</div></div>
                        <div className="p-6 rounded-2xl bg-[#0F131F]/50 border border-gray-800 text-center hover:border-indigo-500/30 transition-colors backdrop-blur-sm"><div className="text-3xl font-bold text-white mb-1 font-mono"><Counter from={0} to={5000} suffix="+" /></div><div className="text-xs uppercase tracking-widest text-gray-500 font-bold">Files Secured</div></div>
                        <div className="p-6 rounded-2xl bg-[#0F131F]/50 border border-gray-800 text-center hover:border-indigo-500/30 transition-colors backdrop-blur-sm"><div className="text-3xl font-bold text-white mb-1 font-mono">~20ms</div><div className="text-xs uppercase tracking-widest text-gray-500 font-bold">Global Latency</div></div>
                        <div className="p-6 rounded-2xl bg-[#0F131F]/50 border border-gray-800 text-center hover:border-indigo-500/30 transition-colors backdrop-blur-sm"><div className="text-3xl font-bold text-white mb-1 font-mono">$0.00</div><div className="text-xs uppercase tracking-widest text-gray-500 font-bold">Cost to You</div></div>
                    </div>
                </div>
            </section>

            <motion.section id="philosophy" className="py-24 md:py-32 bg-[#05080F] relative overflow-hidden" initial={{ opacity: 0, y: 50 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-100px" }} transition={{ duration: 0.8 }}>
                <div className="absolute top-0 left-0 w-full h-full opacity-20 pointer-events-none">
                    <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-[120px]"></div>
                    <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-600/20 rounded-full blur-[120px]"></div>
                </div>
                <div className="container mx-auto px-6 relative z-10">
                    <div className="max-w-4xl mx-auto text-center">
                        <h2 className="text-xs font-bold text-indigo-400 tracking-[0.2em] uppercase mb-6">Manifesto</h2>
                        <h3 className="text-3xl md:text-5xl font-bold mb-8 leading-tight">We believe you should own your data.<br /> Not rent it.</h3>
                        <p className="text-xl text-gray-400 leading-relaxed mb-12">DaemonClient isn't just a tool; it's a statement. By decoupling the storage layer (Telegram) from the access layer (DaemonClient), we create a system where no single entity controls your digital life.</p>
                        <div className="grid md:grid-cols-2 gap-6 text-left">
                            <div className="p-8 rounded-2xl bg-gradient-to-br from-[#0F131F] to-gray-900 border border-gray-800 hover:border-indigo-500/30 transition-colors group"><h4 className="text-xl font-bold text-white mb-3 flex items-center gap-2"><Lock className="w-5 h-5 text-indigo-500 group-hover:text-indigo-400" /> True Privacy</h4><p className="text-gray-400 leading-relaxed">We use a "Zero-Knowledge" setup. After creation, we transfer bot ownership to you and delete our access tokens.</p></div>
                            <div className="p-8 rounded-2xl bg-gradient-to-br from-[#0F131F] to-gray-900 border border-gray-800 hover:border-indigo-500/30 transition-colors group"><h4 className="text-xl font-bold text-white mb-3 flex items-center gap-2"><Server className="w-5 h-5 text-indigo-500 group-hover:text-indigo-400" /> Zero Cost</h4><p className="text-gray-400 leading-relaxed">We abuse no bugs. We simply use the API as intended, utilizing its generous limits very efficiently.</p></div>
                        </div>
                    </div>
                </div>
            </motion.section>

            <motion.section id="how-it-works" className="py-24 bg-[#05080F] relative" initial={{ opacity: 0, y: 50 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-100px" }} transition={{ duration: 0.8 }}>
                <div className="container mx-auto px-6">
                    <div className="text-center mb-20"><h2 className="text-xs font-bold text-indigo-400 tracking-[0.2em] uppercase mb-3">Architecture</h2><h3 className="text-3xl md:text-4xl font-bold text-white">Set up in 3 minutes. Forever.</h3></div>
                    <div className="grid md:grid-cols-3 gap-12 max-w-6xl mx-auto relative">
                        <div className="hidden md:block absolute top-6 left-[20%] right-[20%] h-[2px] bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent -z-0"></div>
                        <StepCard number="1" title="Create a Bot" description="Our automated wizard helps you create a free Telegram bot. This bot acts as your personal, private file manager." />
                        <StepCard number="2" title="Secure Channel" description="We automatically create a private, encrypted channel that only YOU and your bot can access. This is your vault." />
                        <StepCard number="3" title="Ownership Transfer" description="The final step transfers full ownership of the bot and channel to you. We delete our keys. You are in total control." />
                    </div>
                </div>
            </motion.section>

            <motion.section id="protocol" className="py-24 bg-[#05080F] relative border-t border-gray-800/30" initial={{ opacity: 0, y: 50 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-100px" }} transition={{ duration: 0.8 }}>
                <div className="container mx-auto px-6">
                    <div className="text-center mb-20"><h2 className="text-xs font-bold text-cyan-400 tracking-[0.2em] uppercase mb-3">The Protocol</h2><h3 className="text-3xl md:text-4xl font-bold text-white">How We Achieved Infinite Storage</h3></div>
                    <div className="grid md:grid-cols-3 gap-8">
                        <AlgoStep title="1. Atomic Chunking" description="Large files are split into encrypted 19MB shards directly in your browser. This bypasses Telegram's file size limits and allows for parallel, high-speed uploads." visual={<div className="relative w-full h-full flex items-center justify-center gap-2"><div className="w-12 h-16 bg-gray-700 rounded border border-gray-500 flex items-center justify-center text-[10px]">FILE</div><span className="text-gray-500">➔</span><div className="grid grid-cols-3 gap-1">{[...Array(6)].map((_, i) => (<motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.1, duration: 0.5, repeat: Infinity, repeatDelay: 2 }} className="w-6 h-6 bg-indigo-600 rounded border border-indigo-400" />))}</div></div>} />
                        <AlgoStep title="2. Zero-Cost Distribution" description="We use a custom Cloudflare Worker as a transparent proxy. Data streams from your device -> Edge -> Telegram. It never touches our servers, costing us $0." visual={<div className="relative w-full h-full flex items-center justify-center"><div className="absolute w-full h-[1px] bg-gray-700"></div><motion.div animate={{ x: [-60, 60] }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }} className="w-3 h-3 bg-cyan-400 rounded-full shadow-[0_0_10px_cyan] z-10" /><div className="absolute left-8 p-1 bg-gray-800 rounded border border-gray-600 text-[10px]">You</div><div className="absolute right-8 p-1 bg-indigo-900 rounded border border-indigo-500 text-[10px]">Cloud</div></div>} />
                        <AlgoStep title="3. Metadata Indexing" description="A lightweight pointer map is stored in Firebase. It remembers which 19MB chunks belong to 'Holiday_Video.mp4', allowing instant reconstruction when you download." visual={<div className="w-full h-full flex flex-col items-center justify-center gap-2 font-mono text-[10px] text-green-400/80"><div className="w-40 p-2 bg-gray-900 border border-green-900 rounded shadow-[0_0_10px_rgba(74,222,128,0.1)]">{"{ id: 'vid.mp4',"} <br />{"  parts: [892, 893...] }"}</div></div>} />
                    </div>
                </div>
            </motion.section>

            <motion.section id="features" className="py-24 bg-[#0B0F19]" initial={{ opacity: 0, y: 50 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-100px" }} transition={{ duration: 0.8 }}>
                <div className="container mx-auto px-6">
                    <div className="flex flex-col lg:flex-row gap-12 items-center">
                        <div className="lg:w-5/12 space-y-3 w-full">
                            <h2 className="text-3xl md:text-4xl font-bold mb-8">Engineered for Power Users</h2>
                            {features.map((feature, index) => (
                                <div key={index} onClick={() => setActiveFeature(index)} className={`p-5 rounded-xl border transition-all cursor-pointer duration-300 ${activeFeature === index ? 'bg-[#151926] border-indigo-500/50 shadow-lg shadow-indigo-500/10' : 'bg-transparent border-transparent hover:bg-gray-900/50'}`}>
                                    <div className="flex items-center gap-3 mb-1"><div className={`p-1.5 rounded-lg ${activeFeature === index ? 'bg-indigo-500/20 text-indigo-400' : 'bg-gray-800/50 text-gray-500'}`}>{feature.icon}</div><h3 className={`text-base font-bold ${activeFeature === index ? 'text-white' : 'text-gray-400'}`}>{feature.title}</h3></div>
                                    <p className={`text-sm leading-relaxed pl-[46px] ${activeFeature === index ? 'text-gray-300' : 'text-gray-600'}`}>{feature.desc}</p>
                                </div>
                            ))}
                        </div>
                        <div className="w-full lg:w-7/12 h-[350px] flex items-center justify-center mt-8 lg:mt-0">
                            <AnimatePresence mode="wait">
                                <motion.div key={activeFeature} initial={{ opacity: 0, x: 20, filter: "blur(4px)" }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }} exit={{ opacity: 0, x: -20, filter: "blur(4px)" }} transition={{ duration: 0.3 }} className="w-full flex justify-center items-center">{features[activeFeature].visual}</motion.div>
                            </AnimatePresence>
                        </div>
                    </div>
                </div>
            </motion.section>

            <motion.section id="download" className="py-24 relative bg-[#05080F] border-t border-gray-800/50" initial={{ opacity: 0, y: 50 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: "-100px" }} transition={{ duration: 0.8 }}>
                <div className="container mx-auto px-6">
                    <div className="text-center mb-16"><h2 className="text-3xl md:text-4xl font-bold mb-6">Download & Install</h2><p className="text-gray-400 text-lg max-w-xl mx-auto">Access your files from any device.</p></div>
                    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
                        <DownloadOption title="Web App" icon={<Globe className="w-6 h-6" />} status="Live" description="Instant access from any browser. No installation required." buttonText="Launch Now" onClick={onLaunchApp} primary={true} />
                        <DownloadOption title="Daemon CLI" icon={<Terminal className="w-6 h-6" />} status="Live" description="Powerful terminal tool for power users. Scriptable uploads and sync." buttonText="Install" onClick={() => setActiveDownload(activeDownload === 'cli' ? null : 'cli')} isActive={activeDownload === 'cli'} primary={false} />
                        <DownloadOption title="Desktop Sync" icon={<Laptop className="w-6 h-6" />} status="Beta" description="Native app for Windows, Mac, and Linux. Automatic folder sync." buttonText="Coming Soon" onClick={() => setActiveDownload(activeDownload === 'desktop' ? null : 'desktop')} isActive={activeDownload === 'desktop'} />
                        <DownloadOption title="Mobile App" icon={<Smartphone className="w-6 h-6" />} status="Coming Soon" description="iOS and Android apps for on-the-go access." buttonText="Notify Me" onClick={() => setActiveDownload(activeDownload === 'mobile' ? null : 'mobile')} isActive={activeDownload === 'mobile'} />
                    </div>
                    <AnimatePresence>
                        {activeDownload === 'cli' && (<motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden"><div className="max-w-3xl mx-auto bg-[#0B0F19] rounded-2xl overflow-hidden border border-gray-800 shadow-2xl"><div className="bg-[#151926] px-6 py-3 border-b border-gray-800 flex items-center justify-between"><div className="flex gap-2"><div className="w-3 h-3 rounded-full bg-red-500/80"></div><div className="w-3 h-3 rounded-full bg-yellow-500/80"></div><div className="w-3 h-3 rounded-full bg-green-500/80"></div></div><span className="text-xs text-gray-500 font-mono font-bold">TERMINAL</span></div><div className="p-8 font-mono text-sm"><div className="mb-8"><p className="text-gray-500 mb-3 uppercase text-xs font-bold tracking-wider">Option 1: PIP Install</p><div className="flex items-center justify-between bg-indigo-950/20 border border-indigo-500/20 p-4 rounded-xl group transition-colors hover:border-indigo-500/40"><div className="flex gap-3 text-gray-300"><span className="text-indigo-400 select-none">$</span><code>pip install daemon-cli</code></div><button className="text-gray-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100" onClick={() => navigator.clipboard.writeText('pip install daemon-cli')} title="Copy"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg></button></div></div><div><p className="text-gray-500 mb-3 uppercase text-xs font-bold tracking-wider">Option 2: Standalone Binary</p><div className="flex flex-wrap gap-3">{['Linux (x64)', 'Windows (.exe)', 'macOS (M1/Intel)'].map((platform) => (<a key={platform} href="#" className="px-4 py-2 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors border border-gray-700 text-xs font-bold hover:border-gray-500">{platform}</a>))}</div></div></div></div></motion.div>)}
                        {activeDownload === 'desktop' && (<motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="text-center text-gray-400 py-8"><p>Desktop Sync is currently in closed beta. <a href="#" className="text-indigo-400 underline">Join the waitlist</a> to get early access.</p></motion.div>)}
                        {activeDownload === 'mobile' && (<motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="text-center text-gray-400 py-8"><p>Mobile apps are under active development. Follow us on <a href="https://t.me/daemonclient" className="text-indigo-400 underline">Telegram</a> for updates.</p></motion.div>)}
                    </AnimatePresence>
                </div>
            </motion.section>

            {/* Footer */}
            <footer className="bg-[#020408] py-12 border-t border-gray-800">
                <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
                    <div className="flex items-center gap-3 opacity-50 hover:opacity-100 transition-opacity">
                        {/* LOGO UPDATE START */}
                        <img src="/logo.png" alt="Logo" className="w-6 h-6 grayscale opacity-80" />
                        {/* LOGO UPDATE END */}
                        <p className="text-gray-500 text-sm font-medium">&copy; {new Date().getFullYear()} DaemonClient</p>
                    </div>
                    <div className="flex gap-8 text-sm text-gray-500 font-medium">
                        <a href="#" className="hover:text-white transition-colors">Terms</a>
                        <a href="#" className="hover:text-white transition-colors">Privacy</a>
                        <a href="https://t.me/daemonclient" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">Telegram</a>
                        <a href="https://github.com/myrosama/DaemonClient" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">GitHub</a>
                    </div>
                </div>
            </footer>
        </div>
    );
};

// ============================================================================
// --- MAIN APP COMPONENT (The Router) ---
// ============================================================================
function App() {
    const [user, setUser] = useState(null);
    const [appState, setAppState] = useState('loading');

    useEffect(() => {
        const unsubscribe = auth.onAuthStateChanged(async (currentUser) => {
            if (!currentUser) {
                // Default to 'landing' state when no user is found.
                // We keep the old logic of defaulting to auth if they hit 'Launch App'
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

    // HANDLERS PASSED TO CHILDREN
    const handleLaunchApp = () => { setAppState('auth'); };
    const handleSetupComplete = () => { setAppState('transfer'); };
    const handleOwnershipConfirmed = () => { setAppState('dashboard'); };

    if (appState === 'loading') return <FullScreenLoader message="Initializing App..." />;

    // THE ROUTING LOGIC
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
}

export default App;