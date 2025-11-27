import React from 'react';
import { motion } from 'framer-motion';

// --- Icons ---
const CloudIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
  </svg>
);

const LockIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
  </svg>
);

const TerminalIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

// --- 3D Logo Component ---
const Floating3DLogo = () => {
  return (
    <div className="relative w-full h-full flex items-center justify-center perspective-1000">
      {/* Glowing Background Orbs */}
      <motion.div 
        animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        className="absolute w-64 h-64 bg-indigo-500 rounded-full blur-[100px] -z-10"
      />
      <motion.div 
        animate={{ scale: [1.2, 1, 1.2], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 5, repeat: Infinity, ease: "easeInOut", delay: 1 }}
        className="absolute w-64 h-64 bg-cyan-500 rounded-full blur-[100px] -z-10 translate-x-10 translate-y-10"
      />

      {/* The Floating Logo */}
      <motion.div
        initial={{ y: 0, rotateY: 0, rotateX: 0 }}
        animate={{ 
          y: [-20, 20, -20],  // Float up and down
          rotateY: [-10, 10, -10], // Subtle 3D rotation Y
          rotateX: [5, -5, 5] // Subtle 3D rotation X
        }}
        transition={{ 
          duration: 6, 
          repeat: Infinity, 
          ease: "easeInOut" 
        }}
        className="relative z-10"
      >
        {/* Glassmorphism Container Card */}
        <div className="bg-gray-800/40 backdrop-blur-xl border border-gray-700/50 p-12 rounded-3xl shadow-2xl transform-style-3d">
             <img 
              src="/logo.png" 
              alt="DaemonClient 3D Logo" 
              className="w-48 h-48 md:w-64 md:h-64 object-contain drop-shadow-2xl"
              style={{ filter: "drop-shadow(0 0 20px rgba(99, 102, 241, 0.5))" }}
            />
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
    className="bg-gray-800/50 backdrop-blur-sm p-6 rounded-xl border border-gray-700 hover:border-indigo-500 transition-all hover:-translate-y-1 hover:shadow-lg hover:shadow-indigo-500/20"
  >
    <div className="mb-4 p-3 bg-gray-900 rounded-lg inline-block border border-gray-700">{icon}</div>
    <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
    <p className="text-gray-400 leading-relaxed">{description}</p>
  </motion.div>
);

const DownloadOption = ({ title, icon, status, description, buttonText, href, primary }) => (
  <div className={`p-6 rounded-xl border transition-all duration-300 hover:-translate-y-1 ${primary ? 'border-indigo-500 bg-indigo-900/10 hover:bg-indigo-900/20' : 'border-gray-700 bg-gray-800/50 hover:bg-gray-800'} flex flex-col h-full`}>
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-lg font-bold text-white flex items-center gap-2">
        {icon} {title}
      </h3>
      {status && (
        <span className={`text-xs px-2 py-1 rounded-full font-medium border ${
          status === 'Live' 
            ? 'bg-green-900/30 text-green-300 border-green-800' 
            : 'bg-yellow-900/30 text-yellow-300 border-yellow-800'
        }`}>
          {status}
        </span>
      )}
    </div>
    <p className="text-gray-400 text-sm mb-6 flex-grow leading-relaxed">{description}</p>
    <a 
      href={href || "#"}
      className={`w-full py-3 px-4 rounded-lg text-center font-semibold transition-all ${
        primary 
          ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-900/50' 
          : 'bg-gray-700 hover:bg-gray-600 text-gray-200 cursor-not-allowed'
      }`}
      onClick={e => !href && e.preventDefault()}
    >
      {buttonText}
    </a>
  </div>
);

export default function LandingPage({ onLaunchApp }) {
  return (
    <div className="min-h-screen bg-[#0B0F19] text-white font-sans selection:bg-indigo-500 selection:text-white overflow-x-hidden">
      
      {/* Navbar */}
      <nav className="fixed top-0 w-full z-50 bg-[#0B0F19]/80 backdrop-blur-md border-b border-gray-800">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => window.scrollTo(0,0)}>
            <img src="/logo.png" alt="Logo" className="h-8 w-8" />
            <span className="text-xl font-bold tracking-tight">DaemonClient</span>
          </div>
          <div className="hidden md:flex gap-8 text-sm font-medium text-gray-400">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#download" className="hover:text-white transition-colors">Download</a>
            <a href="https://github.com/myrosama/DaemonClient" target="_blank" className="hover:text-white transition-colors">GitHub</a>
          </div>
          <button 
            onClick={onLaunchApp}
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg font-medium transition-all shadow-lg shadow-indigo-900/20 hover:shadow-indigo-900/40"
          >
            Launch App
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <header className="container mx-auto px-6 pt-32 pb-20 md:pt-40 md:pb-32 flex flex-col md:flex-row items-center relative">
        <div className="md:w-1/2 md:pr-12 z-10">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >
            <span className="inline-block py-1 px-3 rounded-full bg-indigo-900/30 border border-indigo-500/30 text-indigo-300 text-sm font-medium mb-6">
              🚀 Now available in Public Beta
            </span>
            <h1 className="text-5xl md:text-7xl font-bold leading-tight mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white to-gray-400">
              Your Cloud.<br />
              <span className="text-indigo-500">Uncompromised.</span>
            </h1>
            <p className="text-xl text-gray-400 mb-8 leading-relaxed max-w-lg">
              The first zero-cost, infinite cloud storage platform built on Telegram. 
              End-to-end encryption. Open Source. No subscription fees.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <button onClick={onLaunchApp} className="bg-indigo-600 hover:bg-indigo-500 px-8 py-4 rounded-xl font-bold text-lg transition-all shadow-xl shadow-indigo-900/30 hover:shadow-indigo-900/50 hover:-translate-y-1">
                Start Uploading
              </button>
              <a href="#download" className="bg-[#1A1F2E] hover:bg-gray-800 px-8 py-4 rounded-xl font-bold text-lg transition-all border border-gray-700 hover:border-gray-600 flex items-center justify-center gap-2 group">
                <TerminalIcon />
                <span>Download CLI</span>
              </a>
            </div>
          </motion.div>
        </div>
        
        {/* 3D Animation Section */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1 }}
          className="md:w-1/2 mt-16 md:mt-0 h-[400px] md:h-[600px] w-full flex items-center justify-center relative"
        >
            <Floating3DLogo />
        </motion.div>
      </header>

      {/* Features Section */}
      <section id="features" className="py-24 bg-[#0B0F19] relative">
        <div className="absolute inset-0 bg-gradient-to-b from-[#0B0F19] via-[#111827] to-[#0B0F19] opacity-50 -z-10"></div>
        <div className="container mx-auto px-6">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-5xl font-bold mb-6">Why DaemonClient?</h2>
            <p className="text-gray-400 max-w-2xl mx-auto text-lg">
              We reverse-engineered the concept of cloud storage to be user-first, free, and infinitely scalable.
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard 
              icon={<CloudIcon />}
              title="Unlimited Storage"
              description="Stop paying for Gigabytes. We leverage Telegram's massive infrastructure to let you store Terabytes of data without paying a cent."
              delay={0.2}
            />
            <FeatureCard 
              icon={<LockIcon />}
              title="Zero-Knowledge"
              description="We don't hold the keys. Your data is chunked, encrypted, and stored in a private channel that only YOU can access."
              delay={0.4}
            />
            <FeatureCard 
              icon={<TerminalIcon />}
              title="Developer First"
              description="Built for automation. Use our powerful CLI and API to script backups, sync servers, and integrate storage into your workflow."
              delay={0.6}
            />
          </div>
        </div>
      </section>

      {/* Download / CLI Section */}
      <section id="download" className="py-24 relative overflow-hidden">
         {/* Background Glow */}
         <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-900/10 rounded-full blur-[120px] -z-10"></div>

        <div className="container mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-5xl font-bold mb-6">Download & Install</h2>
            <p className="text-gray-400 text-lg">Available everywhere you work.</p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
            <DownloadOption 
              title="Web App" 
              icon={<span className="text-2xl">🌐</span>}
              status="Live"
              description="Instant access from any browser. No installation required. Optimized for performance."
              buttonText="Launch Now"
              href="#"
              primary={true}
            />
            <DownloadOption 
              title="Daemon CLI" 
              icon={<span className="text-2xl">💻</span>}
              status="Live"
              description="Powerful terminal tool for power users. Scriptable uploads, downloads, and sync."
              buttonText="View on GitHub"
              href="https://github.com/myrosama/DaemonClient"
              primary={false}
            />
            <DownloadOption 
              title="Desktop Sync" 
              icon={<span className="text-2xl">🖥️</span>}
              status="Beta"
              description="Native app for Windows, Mac, and Linux. Automatic background folder synchronization."
              buttonText="Coming Soon"
            />
            <DownloadOption 
              title="Mobile App" 
              icon={<span className="text-2xl">📱</span>}
              status="Coming Soon"
              description="iOS and Android apps for on-the-go access to your private cloud."
              buttonText="Notify Me"
            />
          </div>

          {/* CLI Installation Code Block */}
          <div className="max-w-3xl mx-auto bg-[#0F131F] rounded-xl overflow-hidden border border-gray-800 shadow-2xl">
            <div className="bg-[#151926] px-4 py-3 border-b border-gray-800 flex items-center gap-2">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
              </div>
              <span className="ml-4 text-xs text-gray-500 font-mono">Quick Install</span>
            </div>
            <div className="p-8 font-mono text-sm">
              <p className="text-gray-500 mb-3"># Install via pip (Python 3.10+)</p>
              <div className="flex items-center justify-between bg-black/40 border border-gray-800 p-4 rounded-lg group transition-colors hover:border-indigo-500/30">
                <div className="flex gap-2 text-gray-300">
                  <span className="text-indigo-500">$</span>
                  <code>pip install daemon-cli</code>
                </div>
                <button 
                  className="text-gray-500 hover:text-white transition-colors opacity-0 group-hover:opacity-100" 
                  onClick={() => navigator.clipboard.writeText('pip install daemon-cli')}
                  title="Copy to clipboard"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </button>
              </div>
              
              <p className="text-gray-500 mt-6 mb-3"># Or download standalone binary</p>
              <div className="flex flex-wrap gap-4 text-indigo-400">
                <a href="#" className="hover:text-indigo-300 hover:underline decoration-indigo-500/30 underline-offset-4">Linux (x64)</a>
                <span className="text-gray-700">|</span>
                <a href="#" className="hover:text-indigo-300 hover:underline decoration-indigo-500/30 underline-offset-4">Windows (.exe)</a>
                <span className="text-gray-700">|</span>
                <a href="#" className="hover:text-indigo-300 hover:underline decoration-indigo-500/30 underline-offset-4">macOS (M1/Intel)</a>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#05080F] py-12 border-t border-gray-800">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-2">
               <img src="/logo.png" alt="Logo" className="h-6 w-6 opacity-50 grayscale" />
               <p className="text-gray-600 text-sm">&copy; {new Date().getFullYear()} DaemonClient. Open Source.</p>
            </div>
            <div className="flex gap-8 text-sm text-gray-600">
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