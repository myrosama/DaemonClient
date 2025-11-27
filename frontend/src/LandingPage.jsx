import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// --- Icons ---
const CloudIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
  </svg>
);

const LockIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
  </svg>
);

const TerminalIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const ServerIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
    </svg>
);

// --- ANIMATED COUNTER ---
const Counter = ({ from, to, suffix = "" }) => {
  const [count, setCount] = useState(from);
  
  useEffect(() => {
    const controls = { value: from };
    const step = (to - from) / 60; 
    const interval = setInterval(() => {
        controls.value += step;
        if (controls.value >= to) {
            setCount(to);
            clearInterval(interval);
        } else {
            setCount(Math.floor(controls.value));
        }
    }, 20);
    return () => clearInterval(interval);
  }, [from, to]);

  return <span>{count.toLocaleString()}{suffix}</span>;
};

// --- VISUAL 1: TERMINAL DEMO ---
const TerminalDemo = () => {
  const [text, setText] = useState('');
  const fullText = "> daemon upload secret_plans.pdf\n[+] Encrypting file...\n[+] Chunking into 19MB parts...\n[+] Uploading to secure channel...\n[+] File 'secret_plans.pdf' registered.\n> ";

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setText(fullText.slice(0, i));
      i++;
      if (i > fullText.length) {
        clearInterval(interval);
        setTimeout(() => { i=0; setText(''); }, 4000); 
      }
    }, 40);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#0F131F] rounded-xl border border-gray-800 p-6 font-mono text-sm shadow-2xl w-full h-64 flex flex-col">
      <div className="flex gap-2 mb-4 border-b border-gray-800 pb-4">
        <div className="w-3 h-3 rounded-full bg-red-500/50" />
        <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
        <div className="w-3 h-3 rounded-full bg-green-500/50" />
        <span className="ml-auto text-xs text-gray-600">bash</span>
      </div>
      <div className="text-gray-300 whitespace-pre-line flex-grow overflow-hidden">
        {text}<span className="animate-pulse inline-block w-2 h-4 bg-indigo-500 align-middle ml-1" />
      </div>
    </div>
  );
};

// --- VISUAL 2: INFINITY ANIMATION ---
const InfinityVisual = () => (
    <div className="relative w-full h-64 flex items-center justify-center bg-[#0F131F] rounded-xl border border-gray-800 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-transparent"></div>
        <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
            className="w-32 h-32 rounded-full border-2 border-dashed border-indigo-500/30"
        />
        <motion.div 
            animate={{ rotate: -360 }}
            transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
            className="absolute w-48 h-48 rounded-full border border-cyan-500/20"
        />
         <div className="absolute text-6xl font-bold text-white/10 select-none">∞</div>
         <motion.div 
            animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 3, repeat: Infinity }}
            className="absolute w-20 h-20 bg-indigo-500/20 rounded-full blur-xl"
         />
    </div>
);

// --- VISUAL 3: SECURITY/CODE ANIMATION ---
const SecurityVisual = () => (
    <div className="relative w-full h-64 flex items-center justify-center bg-[#0F131F] rounded-xl border border-gray-800 overflow-hidden">
         <div className="grid grid-cols-4 gap-2 opacity-20">
            {[...Array(16)].map((_, i) => (
                <motion.div 
                    key={i}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 1, 0] }}
                    transition={{ duration: 2, delay: i * 0.1, repeat: Infinity }}
                    className="w-8 h-8 rounded bg-indigo-500"
                />
            ))}
         </div>
         <div className="absolute inset-0 flex items-center justify-center">
             <div className="p-4 bg-[#0B0F19] rounded-full border border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.3)]">
                <LockIcon />
             </div>
         </div>
    </div>
);


// --- SECURE CLOUD CORE ANIMATION (HERO) ---
const SecureCloudCore = () => {
  return (
    <div className="relative w-full h-[500px] flex items-center justify-center">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(99,102,241,0.15)_0%,_transparent_70%)] blur-3xl" />
      <motion.div 
        animate={{ rotate: 360 }}
        transition={{ duration: 50, repeat: Infinity, ease: "linear" }}
        className="absolute w-[450px] h-[450px] rounded-full border border-indigo-500/10 border-dashed"
      />
      <motion.div 
        animate={{ rotate: -360 }}
        transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
        className="absolute w-[300px] h-[300px] rounded-full border border-cyan-500/20"
        style={{ borderTopColor: 'transparent', borderBottomColor: 'transparent', borderWidth: '2px' }}
      />
      
      {/* Circular Container for Logo - RESTORED TO CIRCLE */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1, y: [0, -15, 0] }}
        transition={{ scale: { duration: 1 }, opacity: { duration: 1 }, y: { duration: 6, repeat: Infinity, ease: "easeInOut" } }}
        className="relative z-10"
      >
        <div className="relative w-40 h-40 md:w-64 md:h-64 bg-[#0F131F]/80 backdrop-blur-xl border border-indigo-500/30 rounded-full flex items-center justify-center shadow-[0_0_80px_rgba(99,102,241,0.2)] overflow-hidden">
           <div className="absolute inset-0 rounded-full bg-gradient-to-tr from-indigo-500/10 to-transparent"></div>
           <motion.img 
             src="/logo.png" 
             alt="Core" 
             className="w-24 h-24 md:w-32 md:h-32 object-contain relative z-20 drop-shadow-[0_0_25px_rgba(99,102,241,0.6)]"
             animate={{ scale: [1, 1.05, 1] }}
             transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
           />
        </div>
      </motion.div>
    </div>
  );
};

// --- COMPONENTS ---
const AlgoStep = ({ title, description, visual }) => (
  <div className="bg-[#0F131F] p-8 rounded-2xl border border-gray-800 hover:border-indigo-500/30 transition-all flex flex-col h-full hover:bg-[#131725] group">
    <div className="h-40 flex items-center justify-center mb-6 bg-black/20 rounded-xl border border-gray-800/50 overflow-hidden relative group-hover:border-indigo-500/20 transition-colors">
       {visual}
    </div>
    <h4 className="text-xl font-bold text-white mb-2 group-hover:text-indigo-400 transition-colors">{title}</h4>
    <p className="text-gray-400 text-sm leading-relaxed">{description}</p>
  </div>
);

const StatCard = ({ number, label }) => (
    <div className="p-6 rounded-2xl bg-[#0F131F]/50 border border-gray-800 text-center hover:border-indigo-500/30 transition-colors backdrop-blur-sm">
        <div className="text-3xl font-bold text-white mb-1 font-mono">{number}</div>
        <div className="text-xs uppercase tracking-widest text-gray-500 font-bold">{label}</div>
    </div>
);

const StepCard = ({ number, title, description }) => (
  <div className="relative flex flex-col items-center text-center p-6 z-10">
    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center text-xl font-bold text-white mb-6 shadow-lg shadow-indigo-900/50">
      {number}
    </div>
    <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
    <p className="text-gray-400 text-sm leading-relaxed">{description}</p>
  </div>
);

const DownloadOption = ({ title, icon, status, description, buttonText, href, primary }) => (
  <div className={`p-8 rounded-2xl border transition-all duration-300 hover:-translate-y-1 ${primary ? 'border-indigo-500 bg-indigo-900/10 hover:bg-indigo-900/20' : 'border-gray-800 bg-[#0F131F] hover:border-gray-700'} flex flex-col h-full group`}>
    <div className="flex items-center justify-between mb-6">
      <h3 className="text-lg font-bold text-white flex items-center gap-3 group-hover:text-indigo-300 transition-colors">
        {icon} {title}
      </h3>
      {status && (
        <span className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border ${
          status === 'Live' ? 'bg-green-900/30 text-green-400 border-green-800' : 'bg-yellow-900/30 text-yellow-400 border-yellow-800'
        }`}>
          {status}
        </span>
      )}
    </div>
    <p className="text-gray-400 text-sm mb-8 flex-grow leading-relaxed">{description}</p>
    <a 
      href={href || "#"}
      className={`w-full py-3 px-6 rounded-lg text-center font-bold tracking-wide transition-all text-sm ${
        primary 
          ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/25' 
          : 'bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white cursor-not-allowed'
      }`}
      onClick={e => !href && e.preventDefault()}
    >
      {buttonText}
    </a>
  </div>
);

const TechStackItem = ({ name }) => (
    <span className="px-4 py-2 rounded-full border border-gray-800 bg-gray-900 text-gray-400 text-sm font-mono hover:border-indigo-500/50 hover:text-indigo-300 transition-colors cursor-default">
        {name}
    </span>
);

export default function LandingPage({ onLaunchApp }) {
  
  // --- CAROUSEL STATE ---
  const [activeFeature, setActiveFeature] = useState(0);
  
  // Auto-rotate carousel
  useEffect(() => {
    const interval = setInterval(() => {
        setActiveFeature((prev) => (prev + 1) % 3);
    }, 5000); // Change every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const features = [
    {
        title: "Daemon CLI",
        desc: "Automate your backups. Write simple scripts to sync folders, upload logs, or manage your cloud from the terminal.",
        icon: <TerminalIcon />,
        visual: <TerminalDemo />
    },
    {
        title: "Infinite Scalability",
        desc: "Whether you store 1GB or 100TB, the protocol handles it. No caps. No throttling. Just raw storage.",
        icon: <CloudIcon />,
        visual: <InfinityVisual />
    },
    {
        title: "Code as Infrastructure",
        desc: "Everything is open source. Audit the code yourself. Host your own instance. You own the platform.",
        icon: <LockIcon />,
        visual: <SecurityVisual />
    }
  ];

  return (
    <div className="min-h-screen bg-[#05080F] text-white font-sans selection:bg-indigo-500 selection:text-white overflow-x-hidden scroll-smooth">
      
      {/* Navbar */}
      <nav className="fixed top-0 w-full z-50 bg-[#05080F]/80 backdrop-blur-md border-b border-gray-800/50">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => window.scrollTo(0,0)}>
            <img src="/logo.png" alt="Logo" className="h-8 w-8" />
            <span className="text-lg font-bold tracking-tight">DaemonClient</span>
          </div>
          <div className="hidden md:flex items-center gap-8">
            <a href="#philosophy" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Philosophy</a>
            <a href="#protocol" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Protocol</a>
            <a href="#features" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Power Users</a>
            <a href="https://github.com/myrosama/DaemonClient" target="_blank" className="text-gray-400 hover:text-white transition-colors">GitHub</a>
            <button onClick={onLaunchApp} className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg text-sm font-semibold transition-all shadow-lg shadow-indigo-900/20 hover:-translate-y-0.5">Launch App</button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <header className="container mx-auto px-6 pt-32 pb-16 md:pt-40 md:pb-24 flex flex-col md:flex-row items-center relative">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] -z-10 pointer-events-none" />
        <div className="md:w-1/2 md:pr-12 z-10">
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            <div className="inline-flex items-center gap-2 py-1 px-3 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 text-xs font-bold uppercase tracking-wider mb-6">
              <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span></span>
              Public Beta Live
            </div>
            <h1 className="text-5xl md:text-7xl font-bold leading-tight mb-6 tracking-tight">
              The Cloud is Broken.<br /><span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">We Fixed It.</span>
            </h1>
            <p className="text-lg text-gray-400 mb-10 leading-relaxed max-w-lg">
              Traditional cloud storage charges you rent for digital space. We reverse-engineered the concept to give you <b>infinite bandwidth</b> and <b>zero costs</b> by owning the infrastructure.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 mb-12">
              <button onClick={onLaunchApp} className="bg-white text-black hover:bg-gray-100 px-8 py-3.5 rounded-xl font-bold text-lg transition-all shadow-[0_0_20px_rgba(255,255,255,0.15)] hover:shadow-[0_0_30px_rgba(255,255,255,0.25)] hover:-translate-y-1">Start Uploading</button>
              <a href="#download" className="bg-[#1A1F2E] hover:bg-gray-800 px-8 py-3.5 rounded-xl font-bold text-lg transition-all border border-gray-700 hover:border-gray-500 flex items-center justify-center gap-2 group text-gray-200">
                <TerminalIcon /><span>Download CLI</span>
              </a>
            </div>
          </motion.div>
        </div>
        <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1, delay: 0.2 }} className="md:w-1/2 mt-12 md:mt-0 h-[400px] md:h-[500px] w-full flex items-center justify-center relative">
            <SecureCloudCore />
        </motion.div>
      </header>

      {/* Live Network Status Bar */}
      <section className="py-10 border-y border-gray-800/50 bg-[#0B0F19]/30 backdrop-blur-sm">
        <div className="container mx-auto px-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                <StatCard number={<Counter from={0} to={99.9} suffix="%" />} label="Uptime" />
                <StatCard number={<Counter from={0} to={5000} suffix="+" />} label="Files Secured" />
                <StatCard number="~20ms" label="Global Latency" />
                <StatCard number="$0.00" label="Cost to You" />
            </div>
        </div>
      </section>

      {/* Philosophy Section */}
      <motion.section 
        id="philosophy" 
        className="py-32 bg-[#05080F] relative overflow-hidden"
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.8 }}
      >
        <div className="absolute top-0 left-0 w-full h-full opacity-20 pointer-events-none">
             <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-[120px]"></div>
             <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-indigo-600/20 rounded-full blur-[120px]"></div>
        </div>
        <div className="container mx-auto px-6 relative z-10">
            <div className="max-w-4xl mx-auto text-center">
                <h2 className="text-xs font-bold text-indigo-400 tracking-[0.2em] uppercase mb-6">Manifesto</h2>
                <h3 className="text-3xl md:text-5xl font-bold mb-8 leading-tight">We believe you should own your data.<br/> Not rent it.</h3>
                <p className="text-xl text-gray-400 leading-relaxed mb-12">
                    DaemonClient isn't just a tool; it's a statement. By decoupling the storage layer (Telegram) from the access layer (DaemonClient), we create a system where no single entity controls your digital life. You hold the keys. You hold the bot. You hold the power.
                </p>
                <div className="grid md:grid-cols-2 gap-6 text-left">
                     <div className="p-8 rounded-2xl bg-gradient-to-br from-[#0F131F] to-gray-900 border border-gray-800 hover:border-indigo-500/30 transition-colors">
                        <h4 className="text-xl font-bold text-white mb-3 flex items-center gap-2">🔒 True Privacy</h4>
                        <p className="text-gray-400 leading-relaxed">We use a "Zero-Knowledge" setup. After creation, we transfer bot ownership to you and delete our access tokens.</p>
                     </div>
                     <div className="p-8 rounded-2xl bg-gradient-to-br from-[#0F131F] to-gray-900 border border-gray-800 hover:border-indigo-500/30 transition-colors">
                        <h4 className="text-xl font-bold text-white mb-3 flex items-center gap-2">💸 Zero Cost</h4>
                        <p className="text-gray-400 leading-relaxed">We abuse no bugs. We simply use the API as intended, utilizing its generous limits very efficiently.</p>
                     </div>
                </div>
            </div>
        </div>
      </motion.section>

      {/* Protocol Section (3-Step Setup) */}
      <motion.section 
        id="how-it-works" 
        className="py-24 bg-[#05080F] relative"
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.8 }}
      >
        <div className="container mx-auto px-6">
          <div className="text-center mb-20">
             <h2 className="text-xs font-bold text-indigo-400 tracking-[0.2em] uppercase mb-3">Architecture</h2>
             <h3 className="text-3xl md:text-4xl font-bold text-white">Set up in 3 minutes. Forever.</h3>
          </div>
          <div className="grid md:grid-cols-3 gap-12 max-w-6xl mx-auto relative">
            <div className="hidden md:block absolute top-6 left-[20%] right-[20%] h-[2px] bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent -z-0"></div>
            <StepCard number="1" title="Create a Bot" description="Our automated wizard helps you create a free Telegram bot. This bot acts as your personal, private file manager." />
            <StepCard number="2" title="Secure Channel" description="We automatically create a private, encrypted channel that only YOU and your bot can access. This is your vault." />
            <StepCard number="3" title="Ownership Transfer" description="The final step transfers full ownership of the bot and channel to you. We delete our keys. You are in total control." />
          </div>
        </div>
      </motion.section>

       {/* Protocol Deep Dive Section */}
      <motion.section 
        id="protocol" 
        className="py-24 bg-[#05080F] relative border-t border-gray-800/30"
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.8 }}
      >
        <div className="container mx-auto px-6">
          <div className="text-center mb-20">
             <h2 className="text-xs font-bold text-cyan-400 tracking-[0.2em] uppercase mb-3">The Protocol</h2>
             <h3 className="text-3xl md:text-4xl font-bold text-white">How We Achieved Infinite Storage</h3>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
             <AlgoStep 
               title="1. Atomic Chunking" 
               description="Large files are split into encrypted 19MB shards directly in your browser. This bypasses Telegram's file size limits and allows for parallel, high-speed uploads."
               visual={
                 <div className="relative w-full h-full flex items-center justify-center gap-2">
                    <div className="w-12 h-16 bg-gray-700 rounded border border-gray-500 flex items-center justify-center text-[10px]">FILE</div>
                    <span className="text-gray-500">➔</span>
                    <div className="grid grid-cols-3 gap-1">
                        {[...Array(6)].map((_, i) => (
                            <motion.div key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i*0.1, duration: 0.5, repeat: Infinity, repeatDelay: 2 }} className="w-6 h-6 bg-indigo-600 rounded border border-indigo-400" />
                        ))}
                    </div>
                 </div>
               }
             />
             <AlgoStep 
               title="2. Zero-Cost Distribution" 
               description="We use a custom Cloudflare Worker as a transparent proxy. Data streams from your device -> Edge -> Telegram. It never touches our servers, costing us $0."
               visual={
                 <div className="relative w-full h-full flex items-center justify-center">
                    <div className="absolute w-full h-[1px] bg-gray-700"></div>
                    <motion.div animate={{ x: [-60, 60] }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }} className="w-3 h-3 bg-cyan-400 rounded-full shadow-[0_0_10px_cyan] z-10" />
                    <div className="absolute left-8 p-1 bg-gray-800 rounded border border-gray-600 text-[10px]">You</div>
                    <div className="absolute right-8 p-1 bg-indigo-900 rounded border border-indigo-500 text-[10px]">Cloud</div>
                 </div>
               }
             />
             <AlgoStep 
               title="3. Metadata Indexing" 
               description="A lightweight pointer map is stored in Firebase. It remembers which 19MB chunks belong to 'Holiday_Video.mp4', allowing instant reconstruction when you download."
               visual={
                 <div className="w-full h-full flex flex-col items-center justify-center gap-2 font-mono text-[10px] text-green-400/80">
                    <div className="w-40 p-2 bg-gray-900 border border-green-900 rounded shadow-[0_0_10px_rgba(74,222,128,0.1)]">
                        {"{ id: 'vid.mp4',"} <br/>
                        {"  parts: [892, 893...] }"}
                    </div>
                 </div>
               }
             />
          </div>
        </div>
      </motion.section>

      {/* CAROUSEL SECTION (Power Users) */}
      <motion.section 
        id="features" 
        className="py-24 bg-[#0B0F19]"
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.8 }}
      >
        <div className="container mx-auto px-6">
          <div className="flex flex-col lg:flex-row gap-16 items-center">
            
            {/* LEFT: Carousel Cards */}
            <div className="lg:w-1/2 space-y-4">
                <h2 className="text-3xl md:text-4xl font-bold mb-8">Engineered for Power Users</h2>
                
                {features.map((feature, index) => (
                    <div 
                        key={index}
                        onClick={() => setActiveFeature(index)}
                        className={`p-6 rounded-xl border transition-all cursor-pointer ${
                            activeFeature === index 
                            ? 'bg-[#151926] border-indigo-500/50 shadow-lg shadow-indigo-500/10 scale-[1.02]' 
                            : 'bg-transparent border-gray-800 hover:bg-gray-900/50'
                        }`}
                    >
                        <div className="flex items-center gap-4 mb-2">
                            <div className={`p-2 rounded-lg ${activeFeature === index ? 'bg-indigo-500/20 text-indigo-400' : 'bg-gray-800 text-gray-500'}`}>
                                {feature.icon}
                            </div>
                            <h3 className={`text-lg font-bold ${activeFeature === index ? 'text-white' : 'text-gray-400'}`}>
                                {feature.title}
                            </h3>
                        </div>
                        <p className={`text-sm leading-relaxed pl-[52px] ${activeFeature === index ? 'text-gray-300' : 'text-gray-600'}`}>
                            {feature.desc}
                        </p>
                    </div>
                ))}
            </div>

            {/* RIGHT: Dynamic Visual */}
            <div className="lg:w-1/2 w-full h-[400px] flex items-center justify-center">
                <AnimatePresence mode="wait">
                    <motion.div
                        key={activeFeature}
                        initial={{ opacity: 0, scale: 0.9, x: 20 }}
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.9, x: -20 }}
                        transition={{ duration: 0.4 }}
                        className="w-full flex justify-center"
                    >
                        {features[activeFeature].visual}
                    </motion.div>
                </AnimatePresence>
            </div>
          </div>
        </div>
      </motion.section>

      {/* Download / CLI Section (Restored Grid) */}
      <motion.section 
        id="download" 
        className="py-24 relative bg-[#05080F] border-t border-gray-800/50"
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.8 }}
      >
        <div className="container mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-6">Download & Install</h2>
            <p className="text-gray-400 text-lg max-w-xl mx-auto">
              Access your files from any device.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
            <DownloadOption title="Web App" icon={<span className="text-2xl">🌐</span>} status="Live" description="Instant access from any browser. No installation required." buttonText="Launch Now" href="#" primary={true} />
            <DownloadOption title="Daemon CLI" icon={<span className="text-2xl">💻</span>} status="Live" description="Powerful terminal tool for power users. Scriptable uploads and sync." buttonText="View on GitHub" href="https://github.com/myrosama/DaemonClient" primary={false} />
            <DownloadOption title="Desktop Sync" icon={<span className="text-2xl">🖥️</span>} status="Beta" description="Native app for Windows, Mac, and Linux. Automatic folder sync." buttonText="Coming Soon" />
            <DownloadOption title="Mobile App" icon={<span className="text-2xl">📱</span>} status="Coming Soon" description="iOS and Android apps for on-the-go access." buttonText="Notify Me" />
          </div>
        </div>
      </motion.section>

      <footer className="bg-[#020408] py-12 border-t border-gray-800">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3 opacity-50 hover:opacity-100 transition-opacity">
               <img src="/logo.png" alt="Logo" className="h-6 w-6 grayscale" />
               <p className="text-gray-500 text-sm font-medium">&copy; {new Date().getFullYear()} DaemonClient</p>
            </div>
            <div className="flex gap-8 text-sm text-gray-500 font-medium">
                <a href="#" className="hover:text-white transition-colors">Terms</a>
                <a href="#" className="hover:text-white transition-colors">Privacy</a>
                <a href="https://twitter.com/montclier49" target="_blank" className="hover:text-white transition-colors">Twitter</a>
                <a href="https://github.com/myrosama/DaemonClient" target="_blank" className="hover:text-white transition-colors">GitHub</a>
            </div>
        </div>
      </footer>
    </div>
  );
}