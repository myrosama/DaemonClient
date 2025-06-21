// src/views/SetupView.js
import React, { useState } from 'react';
// Correct imports from your firebase/config.js and firebase/firestore
import { auth, db, appIdentifier, signOut } from '../firebase/config'; // Use relative path
import { doc, setDoc } from 'firebase/firestore'; // Import doc and setDoc directly if not re-exported

const Loader = () => <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white"></div>;

export default function SetupView({ onSetupComplete }) {
    const [botToken, setBotToken] = useState('');
    const [channelId, setChannelId] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleSaveSetup = async () => {
        if (!botToken || !channelId) {
            setError("Bot Token and Channel ID cannot be empty.");
            return;
        }
        setIsLoading(true);
        setError('');
        
        try {
            const currentUser = auth.currentUser;
            if (!currentUser) {
                setError("No user logged in. Please log in again.");
                setIsLoading(false);
                // Optionally, sign out or redirect to login
                // await signOut(auth); 
                return;
            }
            const userId = currentUser.uid;
            
            // Consistent path with App.js using appIdentifier
            const configPath = `artifacts/${appIdentifier}/users/${userId}/config/telegram`;
            console.log('[SetupView.js] Saving to Firestore path:', configPath);
            const userDocRef = doc(db, configPath);
            
            await setDoc(userDocRef, { 
                botToken: botToken, // Ensure field name matches what App.js checks
                channelId: channelId,
                setupTimestamp: new Date() // Optional: good for debugging
            });
            
            console.log('[SetupView.js] Setup data saved successfully.');
            if (onSetupComplete) {
                onSetupComplete();
            }
        } catch (err) {
            console.error("[SetupView.js] Error saving setup:", err);
            setError(`Failed to save configuration: ${err.message}. Please try again.`);
        } finally {
            setIsLoading(false);
        }
    };

    const handleLogout = async () => {
        try {
            await signOut(auth);
            console.log('[SetupView.js] User logged out.');
            // App.js onAuthStateChanged will handle redirecting to AuthView
        } catch (error) {
            console.error('[SetupView.js] Error logging out:', error);
            setError('Failed to log out.');
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4 font-sans">
            <div className="w-full max-w-2xl bg-gray-800 rounded-xl shadow-2xl p-8">
                <div className="text-center mb-6">
                    <h1 className="text-3xl font-bold text-indigo-400">One-Time Setup</h1>
                    <p className="text-gray-400 mt-2">Let's connect your Telegram bot and channel.</p>
                </div>

                <div className="space-y-6">
                    <div>
                        <label htmlFor="botToken" className="block text-sm font-medium text-gray-300 mb-2">1. Your Telegram Bot Token</label>
                        <p className="text-xs text-gray-500 mb-2">Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline">@BotFather</a> and paste the API token here.</p>
                        <input
                            id="botToken"
                            type="password" // Good for tokens
                            value={botToken}
                            onChange={(e) => setBotToken(e.target.value)}
                            className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-indigo-500"
                            placeholder="e.g., 123456:ABC-DEF1234..."
                        />
                    </div>
                    <div>
                        <label htmlFor="channelId" className="block text-sm font-medium text-gray-300 mb-2">2. Your Private Channel ID</label>
                        <p className="text-xs text-gray-500 mb-2">Create a private channel, add your bot as an admin, then get the Channel ID (e.g., from a bot like @userinfobot, make sure it's the full ID often starting with -100).</p>
                        <input
                            id="channelId"
                            type="text"
                            value={channelId}
                            onChange={(e) => setChannelId(e.target.value)}
                            className="w-full p-3 bg-gray-700 border border-gray-600 rounded-lg text-white focus:ring-2 focus:ring-indigo-500"
                            placeholder="e.g., -1001234567890"
                        />
                    </div>
                    
                    {error && <p className="text-red-400 text-sm text-center py-2">{error}</p>}

                    <button
                        onClick={handleSaveSetup}
                        disabled={isLoading}
                        className="w-full bg-indigo-500 hover:bg-indigo-600 disabled:bg-indigo-800 text-white font-bold py-3 px-4 rounded-lg flex items-center justify-center text-lg transition-colors"
                    >
                        {isLoading ? <Loader /> : 'Save & Continue'}
                    </button>
                </div>
                <div className="text-center mt-6">
                    <button onClick={handleLogout} className="text-sm text-gray-500 hover:text-gray-300">Logout</button>
                </div>
            </div>
        </div>
    );
}