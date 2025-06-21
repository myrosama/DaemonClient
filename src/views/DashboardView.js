import React from 'react';
// FIX: Changed the import path to be an absolute path from the project's 'src'
// directory. This is a standard convention in Create React App and should
// help the build tool locate the configuration file correctly.
import { auth, signOut } from 'firebase/config.js';

// This is the main screen for an authenticated and configured user.
export default function DashboardView() {
    // Get the current user object from Firebase auth.
    const user = auth.currentUser;

    // This function handles logging the user out.
    const handleLogout = async () => {
        try {
            await signOut(auth);
            // The main App.js component's listener will automatically
            // detect the sign-out and switch the view to AuthView.
        } catch (error) {
            console.error("Error signing out: ", error);
            // Optionally, show an error message to the user here.
        }
    };

    return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4 font-sans">
            <div className="w-full max-w-2xl bg-gray-800 rounded-xl shadow-2xl p-8">
                <div className="flex justify-between items-center mb-6">
                    <h1 className="text-3xl font-bold text-indigo-400">DaemonClient</h1>
                    <button
                        onClick={handleLogout}
                        className="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-lg transition-colors"
                    >
                        Logout
                    </button>
                </div>
                <div className="space-y-4">
                    <p className="text-gray-300">Welcome back, <span className="font-semibold text-indigo-400">{user?.email}</span>!</p>
                    <p className="text-gray-300">Your secure storage is ready.</p>
                    <p className="text-xs text-gray-500 break-all">User ID: {user?.uid}</p>
                </div>
                
                {/* This is where the upload and download UI will go later. */}
                <div className="mt-8 space-y-4">
                    <button className="w-full bg-indigo-500 hover:bg-indigo-600 text-white font-bold py-3 px-4 rounded-lg text-lg" disabled>
                        /upload (coming soon)
                    </button>
                    <button className="w-full bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-4 rounded-lg text-lg" disabled>
                        /files (coming soon)
                    </button>
                </div>
            </div>
        </div>
    );
}
