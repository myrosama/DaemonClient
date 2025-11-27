import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

// --- Icons ---
const CloudIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
  </svg>
);

const LockIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
  </svg>
);

const TerminalIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

// --- NEW: Terminal Typing Animation Component ---
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
        setTimeout(() => { i=0; setText(''); }, 5000); // Loop after 5s
      }
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-[#0F131F] rounded-xl border border-gray-800 p-6 font-mono text-sm shadow-2xl w-full max-w-lg mx-auto">
      <div className="flex gap-2 mb-4">
        <div className="w-3 h-3 rounded-full bg-red-500/50" />
        <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
        <div className="w-3 h-3 rounded-full bg-green-500/50" />
      </div>
      <div className="text-gray-300 min-h-[120px] whitespace-pre-line">
        {text}<span className="animate-pulse inline-block w-2 h-4 bg-indigo-500 align-middle ml-1" />
      </div>
    </div>
  );
};

// --- Secure Cloud Core Animation ---
const SecureCloudCore = () => {
  return (
    <div className="relative w-full h-[500px] flex items-center justify-center">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(99,102,241,0.15)_0%,_transparent_70%)] blur-3xl" />
      <motion.div 
        animate={{ rotate: 360 }}
        transition={{ duration: 40, repeat: Infinity, ease: "linear" }}
        className="absolute w-[380px] h-[380px] rounded-full border border-indigo-500/20 border-dashed"
      />
      <motion.div 
        animate={{ rotate: -360 }}
        transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
        className="absolute w-[280px] h-[280px] rounded-full border border-cyan-500/30"
        style={{ borderTopColor: 'transparent', borderBottomColor: 'transparent' }}
      />
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1, y: [0, -10, 0] }}
        transition={{ scale: { duration: 0.8 }, opacity: { duration: 0.8 }, y: { duration: 4, repeat: Infinity, ease: "easeInOut" } }}
        className="relative z-10"
      >
        <div className="relative w-40 h-40 md:w-56 md:h-56 bg-[#0F131F]/80 backdrop-blur-xl border border-indigo-500/30 rounded-3xl flex items-center justify-center shadow-[0_0_60px_rgba(99,102,241,0.15)]">
           <motion.div 
             animate={{ scale: [1, 1.1, 1], opacity: [0.5, 0.2, 0.5] }}
             transition={{ duration: 3, repeat: Infinity }}
             className="absolute inset-4 bg-indigo-500/20 rounded-2xl blur-md"
           />
           <img src="/logo.png" alt="Core" className="w-24 h-24 md:w-32 md:h-32 object-contain relative z-20 drop-shadow-[0_0_15px_rgba(99,102,241,0.5)]"/>
        </div>
      </motion.div>
    </div>
  );
};

const FeatureCard = ({ icon, title, description, delay }) => (
  <motion.div 
    initial={{ opacity: 0, y: 20 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }}
    transition={{ duration: 0.5, delay }}
    className="bg-gray-900/50 backdrop-blur-sm p-8 rounded-2xl border border-gray-800 hover:border-indigo-500/50 transition-all hover:-translate-y-1 hover:shadow-2xl hover:shadow-indigo-900/20 group"
  >
    <div className="mb-6 inline-block p-3 rounded-xl bg-[#0F131F] border border-gray-700 group-hover:border-indigo-500/30 transition-colors">
      {icon}
    </div>
    <h3 className="text-xl font-bold text-white mb-3 group-hover:text-indigo-200 transition-colors">{title}</h3>
    <p className="text-gray-400 leading-relaxed">{description}</p>
  </motion.div>
);

const StepCard = ({ number, title, description }) => (
  <div className="relative flex flex-col items-center text-center p-6 z-10">
    <div className="w-14 h-14 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-2xl font-bold text-indigo-400 mb-6 shadow-[0_0_30px_rgba(99,102,241,0.15)]">
      {number}
    </div>
    <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
    <p className="text-gray-400 text-sm leading-relaxed">{description}</p>
  </div>
);

const DownloadOption = ({ title, icon, status, description, buttonText, href, primary }) => (
  <div className={`p-8 rounded-2xl border transition-all duration-300 hover:-translate-y-1 ${primary ? 'border-indigo-500 bg-indigo-900/10 hover:bg-indigo-900/20' : 'border-gray-800 bg-[#0F131F] hover:border-gray-600'} flex flex-col h-full group`}>
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

export default function LandingPage({ onLaunchApp }) {
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
            <a href="#how-it-works" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Architecture</a>
            <a href="#philosophy" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Philosophy</a>
            <a href="#download" className="text-sm font-medium text-gray-400 hover:text-white transition-colors">Download</a>
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
              Your Cloud.<br /><span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">Uncompromised.</span>
            </h1>
            <p className="text-lg text-gray-400 mb-10 leading-relaxed max-w-lg">
              The first <span className="text-white font-semibold">zero-cost</span>, <span className="text-white font-semibold">infinite</span> cloud storage platform built on Telegram. End-to-end encryption. Open Source. No limits.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
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

      {/* How It Works Section (Unified Background) */}
      <section id="how-it-works" className="py-24 bg-[#05080F] border-y border-gray-800/30 relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-indigo-500/5 rounded-full blur-[100px] -z-10"></div>
        <div className="container mx-auto px-6">
          <div className="text-center mb-20">
             <h2 className="text-xs font-bold text-indigo-400 tracking-[0.2em] uppercase mb-3">Architecture</h2>
             <h3 className="text-3xl md:text-4xl font-bold text-white">Set up in 3 minutes. Forever.</h3>
          </div>
          <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto relative">
            <div className="hidden md:block absolute top-12 left-[20%] right-[20%] h-[2px] bg-gradient-to-r from-transparent via-indigo-500/20 to-transparent -z-0"></div>
            <StepCard number="1" title="Create a Bot" description="Our automated wizard helps you create a free Telegram bot. This bot acts as your personal, private file manager." />
            <StepCard number="2" title="Secure Channel" description="We automatically create a private, encrypted channel that only YOU and your bot can access. This is your vault." />
            <StepCard number="3" title="Ownership Transfer" description="The final step transfers full ownership of the bot and channel to you. We delete our keys. You are in total control." />
          </div>
        </div>
      </section>

      {/* NEW: The Philosophy Section */}
      <section id="philosophy" className="py-32 bg-[#05080F] relative">
        <div className="container mx-auto px-6">
            <div className="flex flex-col md:flex-row gap-16 items-center">
                <div className="md:w-1/2">
                    <TerminalDemo />
                </div>
                <div className="md:w-1/2">
                    <h2 className="text-3xl md:text-4xl font-bold mb-6 leading-tight">The Cloud is Broken. <br/><span className="text-indigo-400">We Fixed It.</span></h2>
                    <p className="text-gray-400 text-lg mb-6 leading-relaxed">
                        Traditional cloud storage charges you rent for digital space. They hold the keys to your data, meaning they can scan, analyze, or delete your files at any time.
                    </p>
                    <p className="text-gray-400 text-lg mb-8 leading-relaxed">
                        <strong>DaemonClient is different.</strong> We reverse-engineered the concept of cloud storage. Instead of selling you server space, we built a protocol that lets you own the infrastructure. By leveraging the massive, free infrastructure of Telegram, we provide infinite storage bandwidth and zero costs.
                    </p>
                    <div className="grid grid-cols-2 gap-6">
                        <div className="p-4 bg-gray-900/50 rounded-xl border border-gray-800">
                            <h4 className="font-bold text-white mb-1">Zero Rent</h4>
                            <p className="text-sm text-gray-500">Pay $0/mo for Terabytes.</p>
                        </div>
                        <div className="p-4 bg-gray-900/50 rounded-xl border border-gray-800">
                            <h4 className="font-bold text-white mb-1">Zero Knowledge</h4>
                            <p className="text-sm text-gray-500">You own the bot keys.</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-24 bg-[#05080F] border-t border-gray-800/30">
        <div className="container mx-auto px-6">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-4xl font-bold mb-6">Engineered for Power Users</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <FeatureCard icon={<CloudIcon />} title="Infinite Storage" description="Stop paying for storage tiers. By leveraging Telegram's massive infrastructure, you can store terabytes of data without paying a cent." delay={0.2} />
            <FeatureCard icon={<LockIcon />} title="Zero-Knowledge" description="We don't hold the keys. Your data is chunked, encrypted, and stored in a private channel that only YOU can access." delay={0.4} />
            <FeatureCard icon={<TerminalIcon />} title="Developer First" description="Built for automation. Use our powerful CLI and API to script backups, sync servers, and integrate storage into your workflow." delay={0.6} />
          </div>
        </div>
      </section>

      {/* Download / CLI Section */}
      <section id="download" className="py-24 relative bg-[#080B14] border-t border-gray-800/50">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-6">Download & Install</h2>
            <p className="text-gray-400 text-lg max-w-xl mx-auto">Access your files from any device. Use the Web App for quick access, or the CLI for power users.</p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
            <DownloadOption title="Web App" icon={<span className="text-2xl">🌐</span>} status="Live" description="Instant access from any browser. No installation required." buttonText="Launch Now" href="#" primary={true} />
            <DownloadOption title="Daemon CLI" icon={<span className="text-2xl">💻</span>} status="Live" description="Powerful terminal tool for power users. Scriptable uploads and sync." buttonText="View on GitHub" href="https://github.com/myrosama/DaemonClient" primary={false} />
            <DownloadOption title="Desktop Sync" icon={<span className="text-2xl">🖥️</span>} status="Beta" description="Native app for Windows, Mac, and Linux. Automatic folder sync." buttonText="Coming Soon" />
            <DownloadOption title="Mobile App" icon={<span className="text-2xl">📱</span>} status="Coming Soon" description="iOS and Android apps for on-the-go access." buttonText="Notify Me" />
          </div>
        </div>
      </section>

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