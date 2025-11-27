import React from 'react';
import { motion } from 'framer-motion';

// --- Icons (Lucide React or Heroicons style) ---
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

const InfinityIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" />
  </svg>
);

const TerminalIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

// --- Components ---

const FeatureCard = ({ icon, title, description, delay }) => (
  <motion.div 
    initial={{ opacity: 0, y: 20 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }}
    transition={{ duration: 0.5, delay }}
    className="bg-gray-800 p-6 rounded-xl border border-gray-700 hover:border-indigo-500 transition-colors"
  >
    <div className="mb-4">{icon}</div>
    <h3 className="text-xl font-bold text-white mb-2">{title}</h3>
    <p className="text-gray-400">{description}</p>
  </motion.div>
);

const DownloadOption = ({ title, icon, status, description, buttonText, href, primary }) => (
  <div className={`p-6 rounded-xl border ${primary ? 'border-indigo-500 bg-indigo-900/10' : 'border-gray-700 bg-gray-800'} flex flex-col h-full`}>
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-lg font-bold text-white flex items-center gap-2">
        {icon} {title}
      </h3>
      {status && (
        <span className={`text-xs px-2 py-1 rounded-full ${status === 'Live' ? 'bg-green-900 text-green-300' : 'bg-yellow-900 text-yellow-300'}`}>
          {status}
        </span>
      )}
    </div>
    <p className="text-gray-400 text-sm mb-6 flex-grow">{description}</p>
    <a 
      href={href || "#"}
      className={`w-full py-2 px-4 rounded-lg text-center font-semibold transition-colors ${
        primary 
          ? 'bg-indigo-600 hover:bg-indigo-700 text-white' 
          : 'bg-gray-700 hover:bg-gray-600 text-gray-300 cursor-not-allowed'
      }`}
      onClick={e => !href && e.preventDefault()}
    >
      {buttonText}
    </a>
  </div>
);

export default function LandingPage({ onLaunchApp }) {
  return (
    <div className="min-h-screen bg-gray-900 text-white font-sans selection:bg-indigo-500 selection:text-white">
      
      {/* Navbar */}
      <nav className="container mx-auto px-6 py-6 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="Logo" className="h-10 w-10" />
          <span className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-cyan-400">
            DaemonClient
          </span>
        </div>
        <div className="hidden md:flex gap-8 text-sm font-medium text-gray-300">
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#download" className="hover:text-white transition-colors">Download</a>
          <a href="https://github.com/myrosama/DaemonClient" target="_blank" className="hover:text-white transition-colors">GitHub</a>
        </div>
        <button 
          onClick={onLaunchApp}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-full font-medium transition-all transform hover:scale-105"
        >
          Launch Web App
        </button>
      </nav>

      {/* Hero Section */}
      <header className="container mx-auto px-6 py-20 md:py-32 flex flex-col md:flex-row items-center">
        <div className="md:w-1/2 md:pr-12">
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="text-5xl md:text-7xl font-bold leading-tight mb-6"
          >
            Your Cloud.<br />
            <span className="text-indigo-500">Your Control.</span>
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-xl text-gray-400 mb-8"
          >
            Unlimited, secure, and free cloud storage built on top of Telegram. 
            Zero-knowledge encryption means only you hold the keys.
          </motion.p>
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="flex gap-4"
          >
            <button onClick={onLaunchApp} className="bg-indigo-600 hover:bg-indigo-700 px-8 py-4 rounded-lg font-bold text-lg transition-transform hover:-translate-y-1">
              Get Started for Free
            </button>
            <a href="#download" className="bg-gray-800 hover:bg-gray-700 px-8 py-4 rounded-lg font-bold text-lg transition-transform hover:-translate-y-1 border border-gray-700">
              Download CLI
            </a>
          </motion.div>
        </div>
        
        {/* Hero Image / Animation */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8 }}
          className="md:w-1/2 mt-12 md:mt-0 relative"
        >
          <div className="relative z-10 bg-gray-800 rounded-2xl p-4 shadow-2xl border border-gray-700">
            <img src="/screenshots/DashboardView.png" alt="App Screenshot" className="rounded-xl shadow-inner" />
          </div>
          {/* Decorative Glow */}
          <div className="absolute -top-10 -right-10 w-72 h-72 bg-indigo-500/30 rounded-full blur-3xl -z-10"></div>
          <div className="absolute -bottom-10 -left-10 w-72 h-72 bg-cyan-500/30 rounded-full blur-3xl -z-10"></div>
        </motion.div>
      </header>

      {/* Features Section */}
      <section id="features" className="py-20 bg-gray-900/50 border-t border-gray-800">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Why DaemonClient?</h2>
            <p className="text-gray-400 max-w-2xl mx-auto">
              We reverse-engineered the concept of cloud storage to be user-first, free, and infinitely scalable.
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard 
              icon={<CloudIcon />}
              title="Unlimited Storage"
              description="Leveraging Telegram's massive infrastructure, store terabytes of data without paying a cent."
              delay={0.2}
            />
            <FeatureCard 
              icon={<LockIcon />}
              title="Zero-Knowledge"
              description="Your data is chunked and stored in a private channel only you access. We can't see your files even if we wanted to."
              delay={0.4}
            />
            <FeatureCard 
              icon={<TerminalIcon />}
              title="Developer First"
              description="Powerful CLI and API for automation. Script your backups, sync folders, and integrate into your workflow."
              delay={0.6}
            />
          </div>
        </div>
      </section>

      {/* Download / CLI Section */}
      <section id="download" className="py-20">
        <div className="container mx-auto px-6">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">Download & Install</h2>
            <p className="text-gray-400">Available everywhere you work.</p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Web App */}
            <DownloadOption 
              title="Web App" 
              icon={<span>🌐</span>}
              status="Live"
              description="Instant access from any browser. No installation required. Zero-cost proxy built-in."
              buttonText="Launch Now"
              href="#"
              primary={true}
            />
            
            {/* CLI */}
            <DownloadOption 
              title="Daemon CLI" 
              icon={<span>💻</span>}
              status="Live"
              description="Powerful terminal tool for power users. Scriptable uploads, downloads, and sync."
              buttonText="View on GitHub"
              href="https://github.com/myrosama/DaemonClient" // Link to your repo
              primary={false}
            />

            {/* Desktop */}
            <DownloadOption 
              title="Desktop Sync" 
              icon={<span>🖥️</span>}
              status="Beta"
              description="Native app for Windows, Mac, and Linux. Automatic folder synchronization."
              buttonText="Coming Soon"
            />

            {/* Mobile */}
            <DownloadOption 
              title="Mobile App" 
              icon={<span>📱</span>}
              status="Coming Soon"
              description="iOS and Android apps for on-the-go access to your private cloud."
              buttonText="Notify Me"
            />
          </div>

          {/* CLI Installation Code Block */}
          <div className="mt-16 max-w-3xl mx-auto bg-gray-800 rounded-xl overflow-hidden border border-gray-700">
            <div className="bg-gray-900 px-4 py-2 border-b border-gray-700 flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span className="ml-2 text-xs text-gray-400 font-mono">Install CLI</span>
            </div>
            <div className="p-6 font-mono text-sm overflow-x-auto">
              <p className="text-gray-400 mb-2"># Install via pip (Python 3.10+)</p>
              <div className="flex justify-between items-center bg-black/30 p-3 rounded-lg">
                <code className="text-green-400">pip install daemon-cli</code>
                <button className="text-gray-500 hover:text-white" onClick={() => navigator.clipboard.writeText('pip install daemon-cli')}>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                </button>
              </div>
              
              <p className="text-gray-400 mt-4 mb-2"># Or download standalone binary</p>
              <div className="flex gap-4">
                <a href="#" className="text-indigo-400 hover:underline">Download for Linux</a>
                <a href="#" className="text-indigo-400 hover:underline">Download for Windows</a>
                <a href="#" className="text-indigo-400 hover:underline">Download for macOS</a>
              </div>
            </div>
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer className="bg-black py-12 border-t border-gray-800 text-center">
        <div className="container mx-auto px-6">
            <p className="text-gray-500">
                &copy; {new Date().getFullYear()} DaemonClient. Open Source & Free Forever.
            </p>
            <div className="mt-4 flex justify-center gap-6">
                <a href="#" className="text-gray-600 hover:text-white">Terms</a>
                <a href="#" className="text-gray-600 hover:text-white">Privacy</a>
                <a href="#" className="text-gray-600 hover:text-white">Twitter</a>
            </div>
        </div>
      </footer>

    </div>
  );
}