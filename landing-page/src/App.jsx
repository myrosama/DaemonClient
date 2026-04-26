import { motion } from 'framer-motion'
import { Cloud, Lock, Zap, Image, HardDrive, Shield, ArrowRight, Github } from 'lucide-react'

function App() {
  return (
    <div className="min-h-screen bg-black text-white">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-black/50 backdrop-blur-xl border-b border-gray-800">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cloud className="w-6 h-6 text-indigo-400" />
            <span className="text-xl font-bold bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
              DaemonClient
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a href="https://github.com/myrosama" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition">
              <Github className="w-5 h-5" />
            </a>
            <a href="https://accounts.daemonclient.uz/login" className="px-4 py-2 text-gray-300 hover:text-white transition">
              Sign In
            </a>
            <a href="https://accounts.daemonclient.uz/signup" className="px-6 py-2 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-lg font-semibold hover:from-indigo-600 hover:to-purple-600 transition shadow-lg shadow-indigo-500/20">
              Get Started
            </a>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="relative pt-32 pb-20 px-6 overflow-hidden">
        {/* Animated background gradient */}
        <div className="absolute inset-0 opacity-30">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500 rounded-full mix-blend-multiply filter blur-3xl animate-pulse"></div>
          <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl animate-pulse delay-75"></div>
          <div className="absolute bottom-1/4 left-1/2 w-96 h-96 bg-pink-500 rounded-full mix-blend-multiply filter blur-3xl animate-pulse delay-150"></div>
        </div>

        <div className="relative max-w-7xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <h1 className="text-6xl md:text-8xl font-bold mb-6 leading-tight">
              <span className="bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 bg-clip-text text-transparent">
                Unlimited Storage.
              </span>
              <br />
              <span className="text-white">Zero Cost.</span>
            </h1>
            <p className="text-xl md:text-2xl text-gray-400 mb-12 max-w-3xl mx-auto">
              Break free from storage limits. Powered by Telegram's distributed infrastructure,
              your data is encrypted, unlimited, and completely free forever.
            </p>
            <div className="flex items-center justify-center gap-4">
              <a
                href="https://accounts.daemonclient.uz/signup"
                className="group px-8 py-4 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-xl font-semibold text-lg hover:from-indigo-600 hover:to-purple-600 transition shadow-2xl shadow-indigo-500/30 flex items-center gap-2"
              >
                Start Free Forever
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition" />
              </a>
            </div>
          </motion.div>

          {/* Feature Pills */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="flex flex-wrap items-center justify-center gap-4 mt-12"
          >
            <div className="px-4 py-2 bg-gray-900/50 backdrop-blur border border-gray-800 rounded-full text-sm text-gray-300 flex items-center gap-2">
              <Lock className="w-4 h-4 text-green-400" />
              End-to-End Encrypted
            </div>
            <div className="px-4 py-2 bg-gray-900/50 backdrop-blur border border-gray-800 rounded-full text-sm text-gray-300 flex items-center gap-2">
              <Zap className="w-4 h-4 text-yellow-400" />
              Lightning Fast
            </div>
            <div className="px-4 py-2 bg-gray-900/50 backdrop-blur border border-gray-800 rounded-full text-sm text-gray-300 flex items-center gap-2">
              <Cloud className="w-4 h-4 text-blue-400" />
              Truly Unlimited
            </div>
          </motion.div>
        </div>
      </section>

      {/* Services Section */}
      <section className="py-20 px-6 bg-gradient-to-b from-black to-gray-900">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Your Complete Cloud <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">Ecosystem</span>
            </h2>
            <p className="text-xl text-gray-400">Everything you need, nothing you don't</p>
          </motion.div>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Photos Service */}
            <motion.a
              href="https://photos.daemonclient.uz"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              whileHover={{ scale: 1.02, y: -8 }}
              className="group p-8 bg-gradient-to-br from-indigo-900/20 to-purple-900/20 backdrop-blur border border-indigo-500/20 rounded-3xl hover:border-indigo-500/50 transition-all duration-300 shadow-xl hover:shadow-indigo-500/20"
            >
              <div className="p-4 bg-indigo-500/10 rounded-2xl w-fit mb-6">
                <Image className="w-12 h-12 text-indigo-400" />
              </div>
              <h3 className="text-3xl font-bold mb-3 text-white">DaemonClient Photos</h3>
              <p className="text-gray-400 mb-6 text-lg">
                Store unlimited photos and videos with automatic organization, facial recognition, and smart search.
                Your memories, preserved forever.
              </p>
              <div className="flex items-center gap-2 text-indigo-400 group-hover:gap-4 transition-all">
                <span className="font-semibold">Explore Photos</span>
                <ArrowRight className="w-5 h-5" />
              </div>
            </motion.a>

            {/* Drive Service */}
            <motion.a
              href="https://app.daemonclient.uz"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
              whileHover={{ scale: 1.02, y: -8 }}
              className="group p-8 bg-gradient-to-br from-purple-900/20 to-pink-900/20 backdrop-blur border border-purple-500/20 rounded-3xl hover:border-purple-500/50 transition-all duration-300 shadow-xl hover:shadow-purple-500/20"
            >
              <div className="p-4 bg-purple-500/10 rounded-2xl w-fit mb-6">
                <HardDrive className="w-12 h-12 text-purple-400" />
              </div>
              <h3 className="text-3xl font-bold mb-3 text-white">DaemonClient Drive</h3>
              <p className="text-gray-400 mb-6 text-lg">
                Store any file type with military-grade encryption. Share securely, sync instantly,
                access anywhere. Your digital vault.
              </p>
              <div className="flex items-center gap-2 text-purple-400 group-hover:gap-4 transition-all">
                <span className="font-semibold">Explore Drive</span>
                <ArrowRight className="w-5 h-5" />
              </div>
            </motion.a>
          </div>
        </div>
      </section>

      {/* Why DaemonClient */}
      <section className="py-20 px-6">
        <div className="max-w-7xl mx-auto">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-4xl md:text-5xl font-bold mb-4">
              Why <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">DaemonClient</span>?
            </h2>
          </motion.div>

          <div className="grid md:grid-cols-3 gap-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="p-6 bg-gray-900/50 backdrop-blur border border-gray-800 rounded-2xl"
            >
              <Shield className="w-10 h-10 text-green-400 mb-4" />
              <h3 className="text-2xl font-bold mb-3">Zero-Knowledge Encryption</h3>
              <p className="text-gray-400">
                Your files are encrypted before they leave your device. Not even we can access your data.
                True privacy, guaranteed.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
              className="p-6 bg-gray-900/50 backdrop-blur border border-gray-800 rounded-2xl"
            >
              <Cloud className="w-10 h-10 text-blue-400 mb-4" />
              <h3 className="text-2xl font-bold mb-3">Truly Unlimited</h3>
              <p className="text-gray-400">
                No storage caps. No file size limits. No hidden fees. Upload as much as you want,
                whenever you want. Forever free.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
              className="p-6 bg-gray-900/50 backdrop-blur border border-gray-800 rounded-2xl"
            >
              <Zap className="w-10 h-10 text-yellow-400 mb-4" />
              <h3 className="text-2xl font-bold mb-3">Blazing Fast</h3>
              <p className="text-gray-400">
                Powered by Telegram's CDN infrastructure across 5 continents.
                Upload and download at maximum speed, anywhere in the world.
              </p>
            </motion.div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-6 bg-gradient-to-b from-gray-900 to-black">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          whileInView={{ opacity: 1, scale: 1 }}
          viewport={{ once: true }}
          className="max-w-4xl mx-auto text-center p-12 bg-gradient-to-br from-indigo-900/30 to-purple-900/30 backdrop-blur border border-indigo-500/30 rounded-3xl"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Ready to break free?
          </h2>
          <p className="text-xl text-gray-400 mb-8">
            Join thousands who've ditched storage limits forever.
          </p>
          <a
            href="https://accounts.daemonclient.uz/signup"
            className="inline-flex items-center gap-2 px-8 py-4 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-xl font-semibold text-lg hover:from-indigo-600 hover:to-purple-600 transition shadow-2xl shadow-indigo-500/30"
          >
            Create Free Account
            <ArrowRight className="w-5 h-5" />
          </a>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="py-12 px-6 border-t border-gray-800">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-gray-500">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-indigo-400" />
            <span>© 2026 DaemonClient. Unlimited. Forever.</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="https://github.com/myrosama" target="_blank" rel="noopener noreferrer" className="hover:text-white transition">
              GitHub
            </a>
            <a href="https://t.me/daemonclient" target="_blank" rel="noopener noreferrer" className="hover:text-white transition">
              Telegram
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
