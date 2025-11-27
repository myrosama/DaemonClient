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

// --- 2.5D Holographic Logo Component ---
const Floating3DLogo = () => {
  return (
    <div className="relative w-full h-full flex items-center justify-center perspective-1000">
      {/* Ambient Glow Behind */}
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

      {/* Floating Container */}
      <motion.div
        initial={{ y: 0, rotateY: 0, rotateX: 0 }}
        animate={{ 
          y: [-15, 15, -15],     // Gentle float up/down
          rotateY: [-12, 12, -12], // Slow rotation on Y axis
          rotateX: [5, -5, 5]    // Subtle tilt on X axis
        }}
        transition={{ 
          duration: 8, 
          repeat: Infinity, 
          ease: "easeInOut" 
        }}
        style={{ transformStyle: "preserve-3d" }}
        className="relative z-10"
      >
        {/* Glass Card */}
        <div className="bg-gray-800/30 backdrop-blur-xl border border-white/10 p-12 rounded-[3rem] shadow-2xl flex items-center justify-center">
             {/* The Logo itself - acting as the 3D object */}
             <img 
              src="/logo.png" 
              alt="DaemonClient Holographic Logo" 
              className="w-48 h-48 md:w-64 md:h-64 object-contain drop-shadow-2xl"
              style={{ 
                filter: "drop-shadow(0 20px 30px rgba(99, 102, 241, 0.4))",
                transform: "translateZ(50px)" // Push it "out" of the card for depth
              }}
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
    className="bg-gray-800/50 backdrop-blur-sm p-8 rounded-2xl border border-gray-700/50 hover:border-indigo-500/50 transition-all hover:-translate-y-1 hover:shadow-2xl hover:shadow-indigo-500/10"
  >
    <div className="mb-6 p-4 bg-gray-900/80 rounded-xl inline-block border border-gray-700 shadow-inner">{icon}</div>
    <h3 className="text-2xl font-bold text-white mb-3">{title}</h3>
    <p className="text-gray-400 leading-relaxed text-lg">{description}</p>
  </motion.div>
);

const StepCard = ({ number, title, description }) => (
  <div className="flex flex-col items-center text-center p-6 relative">
    <div className="w-16 h-16 rounded-full bg-indigo-900/30 border border-indigo-500/30 flex items-center justify-center text-2xl font-bold text-indigo-400 mb-6 shadow-[0_0_30px_rgba(99,102,241,0.2)]">
      {number}
    </div>
    <h3 className="text-xl font-bold text-white mb-3">{title}</h3>
    <p className="text-gray-400 text-sm leading-relaxed">{description}</p>
    
    {/* Connector Line (Hidden on mobile/last item) */}
    {number !== "3" && (
      <div className="hidden md:block absolute top-14 left-[60%] w-[80%] h-[2px] bg-gradient-to-r from-indigo-500/30 to-transparent -z-10"></div>
    )}
  </div>
);

const DownloadOption = ({ title, icon, status, description, buttonText, href, primary }) => (
  <div className={`p-8 rounded-2xl border transition-all duration-300 hover:-translate-y-2 ${primary ? 'border-indigo-500 bg-indigo-900/10 hover:bg-indigo-900/20' : 'border-gray-800 bg-[#0F131F] hover:border-gray-600'} flex flex-col h-full group`}>
    <div className="flex items-center justify-between mb-6">
      <h3 className="text-xl font-bold text-white flex items-center gap-3 group-hover:text-indigo-300 transition-colors">
        {icon} {title}
      </h3>
      {status && (
        <span className={`text-xs px-3 py-1 rounded-full font-semibold border ${
          status === 'Live' 
            ? 'bg-green-500/10 text-green-400 border-green-500/20' 
            : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
        }`}>
          {status}
        </span>
      )}
    </div>
    <p className="text-gray-400 text-sm mb-8 flex-grow leading-relaxed">{description}</p>
    <a 
      href={href || "#"}
      className={`w-full py-4 px-6 rounded-xl text-center font-bold tracking-wide transition-all ${
        primary 
          ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40' 
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
    <div className="min-h-screen bg-[#0B0F19] text-white font-sans selection:bg-indigo-500 selection:text-white overflow-x-hidden scroll-smooth">
      
      {/* Navbar */}
      <nav className="fixed top-0 w-full z-50 bg-[#0B0F19]/80 backdrop-blur-lg border-b border-gray-800/50 supports-[backdrop-filter]:bg-[#0B0F19]/60">
        <div className="container mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3 cursor-pointer group" onClick={() => window.scrollTo(0,0)}>
            <div className="relative">
                <div className="absolute inset-0 bg-indigo-500 blur-lg opacity-0 group-hover:opacity-50 transition-opacity"></div>
                <img src="/logo.png" alt="Logo" className="h-10 w-10 relative z-10" />
            </div>
            <span className="text-xl font-bold tracking-tight group-hover:text-indigo-300 transition-colors">DaemonClient</span>
          </div>
          
          <div className="hidden md:flex items-center gap-8">
            <div className="flex gap-8 text-sm font-medium text-gray-400">
                <a href="#how-it-works" className="hover:text-white transition-colors">How it Works</a>
                <a href="#features" className="hover:text-white transition-colors">Features</a>
                <a href="#download" className="hover:text-white transition-colors">Download</a>
            </div>
            <div className="h-4 w-[1px] bg-gray-700"></div>
            <a href="https://github.com/myrosama/DaemonClient" target="_blank" className="text-gray-400 hover:text-white transition-colors">
                <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            </a>
          </div>

          <button 
            onClick={onLaunchApp}
            className="md:ml-4 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-900/20 hover:shadow-indigo-900/40 hover:-translate-y-0.5"
          >
            Launch App
          </button>
        </div>
      </nav>

      {/* Hero Section */}
      <header className="container mx-auto px-6 pt-32 pb-20 md:pt-48 md:pb-32 flex flex-col md:flex-row items-center relative">
        <div className="md:w-1/2 md:pr-12 z-10">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 py-1 px-3 rounded-full bg-indigo-950/50 border border-indigo-500/30 text-indigo-300 text-sm font-medium mb-8 hover:bg-indigo-900/50 transition-colors cursor-default">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
              </span>
              Now available in Public Beta
            </div>
            
            <h1 className="text-5xl md:text-7xl font-bold leading-tight mb-6 bg-clip-text text-transparent bg-gradient-to-b from-white via-white to-gray-500">
              Your Cloud.<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400">Uncompromised.</span>
            </h1>
            
            <p className="text-xl text-gray-400 mb-10 leading-relaxed max-w-lg">
              The first <span className="text-white font-semibold">zero-cost</span>, <span className="text-white font-semibold">infinite</span> cloud storage platform built on Telegram. 
              End-to-end encryption. Open Source. No limits.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4">
              <button onClick={onLaunchApp} className="bg-white text-black hover:bg-gray-200 px-8 py-4 rounded-xl font-bold text-lg transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)] hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] hover:-translate-y-1">
                Start Uploading
              </button>
              <a href="#download" className="bg-[#1A1F2E] hover:bg-gray-800 px-8 py-4 rounded-xl font-bold text-lg transition-all border border-gray-700 hover:border-gray-500 flex items-center justify-center gap-2 group">
                <TerminalIcon />
                <span>Download CLI</span>
              </a>
            </div>
          </motion.div>
        </div>
        
        {/* 3D Animation Section */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1, delay: 0.2 }}
          className="md:w-1/2 mt-16 md:mt-0 h-[400px] md:h-[600px] w-full flex items-center justify-center relative"
        >
            <Floating3DLogo />
        </motion.div>
      </header>

      {/* How It Works Section (NEW) */}
      <section id="how-it-works" className="py-24 bg-[#0F131F] border-y border-gray-800/50">
        <div className="container mx-auto px-6">
          <div className="text-center mb-20">
             <h2 className="text-sm font-bold text-indigo-500 tracking-widest uppercase mb-3">Simple Onboarding</h2>
             <h3 className="text-3xl md:text-5xl font-bold text-white">Set up in 3 minutes. Forever.</h3>
          </div>

          <div className="grid md:grid-cols-3 gap-12 max-w-5xl mx-auto">
            <StepCard 
              number="1" 
              title="Create a Bot" 
              description="Our automated wizard helps you create a free Telegram bot. This bot acts as your personal, private file manager." 
            />
            <StepCard 
              number="2" 
              title="Secure Channel" 
              description="We automatically create a private, encrypted channel that only YOU and your bot can access. This is your vault." 
            />
            <StepCard 
              number="3" 
              title="Ownership Transfer" 
              description="The final step transfers full ownership of the bot and channel to you. We delete our keys. You are in total control." 
            />
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-32 bg-[#0B0F19] relative">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-[#0B0F19] to-[#0B0F19] opacity-50 -z-10"></div>
        <div className="container mx-auto px-6">
          <div className="text-center mb-24">
            <h2 className="text-3xl md:text-5xl font-bold mb-6">Why DaemonClient?</h2>
            <p className="text-gray-400 max-w-2xl mx-auto text-lg">
              We reverse-engineered the concept of cloud storage to be user-first, free, and infinitely scalable.
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard 
              icon={<CloudIcon />}
              title="Infinite Storage"
              description="Stop paying for storage tiers. By leveraging Telegram's massive infrastructure, you can store terabytes of data without paying a cent. Seriously."
              delay={0.2}
            />
            <FeatureCard 
              icon={<LockIcon />}
              title="Zero-Knowledge"
              description="We don't hold the keys. Your data is chunked, encrypted, and stored in a private channel that only YOU can access. We can't see your files even if we wanted to."
              delay={0.4}
            />
            <FeatureCard 
              icon={<TerminalIcon />}
              title="Developer First"
              description="Built for automation. Use our powerful CLI and API to script backups, sync servers, and integrate storage into your workflow using simple Python or Curl."
              delay={0.6}
            />
          </div>
        </div>
      </section>

      {/* Download / CLI Section */}
      <section id="download" className="py-24 relative overflow-hidden bg-[#0F131F]">
         {/* Background Glow */}
         <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-900/10 rounded-full blur-[120px] -z-10"></div>

        <div className="container mx-auto px-6">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-5xl font-bold mb-6">Download & Install</h2>
            <p className="text-gray-400 text-lg max-w-xl mx-auto">
              Access your files from any device. Use the Web App for quick access, or the CLI for power users.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-20">
            <DownloadOption 
              title="Web App" 
              icon={<span className="text-3xl">🌐</span>}
              status="Live"
              description="Instant access from any browser. No installation required. Zero-cost proxy built-in."
              buttonText="Launch Now"
              href="#"
              primary={true}
            />
            <DownloadOption 
              title="Daemon CLI" 
              icon={<span className="text-3xl">💻</span>}
              status="Live"
              description="Powerful terminal tool for power users. Scriptable uploads, downloads, and sync."
              buttonText="View on GitHub"
              href="https://github.com/myrosama/DaemonClient"
              primary={false}
            />
            <DownloadOption 
              title="Desktop Sync" 
              icon={<span className="text-3xl">🖥️</span>}
              status="Beta"
              description="Native app for Windows, Mac, and Linux. Automatic background folder synchronization."
              buttonText="Coming Soon"
            />
            <DownloadOption 
              title="Mobile App" 
              icon={<span className="text-3xl">📱</span>}
              status="Coming Soon"
              description="iOS and Android apps for on-the-go access to your private cloud."
              buttonText="Notify Me"
            />
          </div>

          {/* CLI Installation Code Block */}
          <div className="max-w-3xl mx-auto bg-[#0B0F19] rounded-2xl overflow-hidden border border-gray-800 shadow-2xl">
            <div className="bg-[#151926] px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div className="flex gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500/80"></div>
                <div className="w-3 h-3 rounded-full bg-green-500/80"></div>
              </div>
              <span className="text-xs text-gray-500 font-mono font-bold">TERMINAL</span>
            </div>
            <div className="p-8 font-mono text-sm">
              <div className="mb-6">
                  <p className="text-gray-500 mb-3"># 1. Install via pip (Requires Python 3.10+)</p>
                  <div className="flex items-center justify-between bg-indigo-950/20 border border-indigo-500/20 p-4 rounded-xl group transition-colors hover:border-indigo-500/40">
                    <div className="flex gap-3 text-gray-300">
                      <span className="text-indigo-400 select-none">$</span>
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
              </div>
              
              <div>
                  <p className="text-gray-500 mb-3"># 2. Or download standalone binary</p>
                  <div className="flex flex-wrap gap-3">
                    {['Linux (x64)', 'Windows (.exe)', 'macOS (M1/Intel)'].map((platform) => (
                        <a key={platform} href="#" className="px-4 py-2 rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors border border-gray-700 text-xs font-bold uppercase tracking-wide">
                            {platform}
                        </a>
                    ))}
                  </div>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#05080F] py-12 border-t border-gray-800">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3">
               <img src="/logo.png" alt="Logo" className="h-8 w-8 opacity-40 grayscale hover:grayscale-0 hover:opacity-100 transition-all duration-500" />
               <p className="text-gray-600 text-sm">
                   &copy; {new Date().getFullYear()} DaemonClient. <br className="md:hidden"/>Built for the community.
               </p>
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