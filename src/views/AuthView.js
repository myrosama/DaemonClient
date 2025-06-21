// src/views/AuthView.js
import React, { useState } from 'react';
import { auth, createUserWithEmailAndPassword, signInWithEmailAndPassword } from '../firebase/config';

export default function AuthView() { // Removed onAuthSuccess prop
  const [isLoginView, setIsLoginView] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleAuthAction = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      if (isLoginView) {
        console.log('[AuthView.js] Attempting login for:', email);
        await signInWithEmailAndPassword(auth, email, password);
        console.log('[AuthView.js] Login successful for:', email);
      } else {
        console.log('[AuthView.js] Attempting registration for:', email);
        await createUserWithEmailAndPassword(auth, email, password);
        console.log('[AuthView.js] Registration successful for:', email);
        // After registration, App.js's onAuthStateChanged will handle the rest.
        // If registration also creates the initial (empty) config, that logic is elsewhere.
      }
      // No need to call onAuthSuccess here, App.js listens to onAuthStateChanged
    } catch (err) {
      console.error('[AuthView.js] Auth error:', err);
      setError(err.message.replace('Firebase: ', ''));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col justify-center items-center p-4 font-sans">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-2">
            <svg className="h-10 w-10 text-indigo-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>
          <h1 className="text-4xl font-bold text-white">DaemonClient</h1>
          <p className="text-indigo-300 mt-2">Secure Cloud Storage</p>
        </div>

        <div className="bg-gray-800 shadow-2xl rounded-xl p-8">
          <div className="flex border-b border-gray-700 mb-6">
            <button
              onClick={() => { setIsLoginView(true); setError(''); }}
              className={`w-1/2 py-3 text-lg font-semibold ${isLoginView ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500'}`}
            >
              Login
            </button>
            <button
              onClick={() => { setIsLoginView(false); setError(''); }}
              className={`w-1/2 py-3 text-lg font-semibold ${!isLoginView ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500'}`}
            >
              Sign Up
            </button>
          </div>

          <form onSubmit={handleAuthAction} className="space-y-6">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">Email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white"
                placeholder="you@example.com"
                required
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-2">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white"
                placeholder="••••••••"
                required
              />
            </div>

            {error && <p className="text-red-400 text-sm text-center">{error}</p>}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full flex justify-center py-3 px-4 rounded-lg text-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-800 disabled:opacity-75"
            >
              {isLoading ? 'Loading...' : (isLoginView ? 'Log In' : 'Create Account')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}