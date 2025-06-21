// src/App.js
import React, { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc } from 'firebase/firestore'; // Static import
import { auth } from '../firebase/config';
import AuthView from './AuthView';
import SetupView from './SetupView';
import DashboardView from './DashboardView';

export default function App() {
  const [user, setUser] = useState(null);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(true); // Start as true to show initial loading

  useEffect(() => {
    console.log('[App.js] Subscribing to auth state changes.');
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      console.log('[App.js] Auth state changed. Current user:', currentUser ? currentUser.uid : 'No user');

      if (currentUser && !currentUser.isAnonymous) {
        setUser(currentUser); // Set user object
        const userId = currentUser.uid;
        console.log('[App.js] User is logged in. UID:', userId);
        console.log('[App.js] Checking setup status...');

        try {
          const db = getFirestore();
          const configPath = `artifacts/default-daemon-client/users/${userId}/config/telegram`;
          console.log('[App.js] Firestore path for config:', configPath);
          const configRef = doc(db, configPath);
          const configSnap = await getDoc(configRef);

          if (configSnap.exists()) {
            console.log('[App.js] Config document found. Data:', configSnap.data());
            const botTokenExists = !!configSnap.data().botToken; // Check if botToken field exists and has a value
            setIsSetupComplete(botTokenExists);
            console.log('[App.js] Setup complete status (based on botToken):', botTokenExists);
          } else {
            console.log('[App.js] Config document NOT found. User needs setup.');
            setIsSetupComplete(false);
          }
        } catch (error) {
          console.error('[App.js] Error fetching user config from Firestore:', error);
          setIsSetupComplete(false); // Assume setup is not complete if there's an error
        } finally {
          setIsLoading(false);
          console.log('[App.js] Finished processing auth state. isLoading: false');
        }
      } else {
        console.log('[App.js] No user logged in or user is anonymous.');
        setUser(null);
        setIsSetupComplete(false);
        setIsLoading(false);
      }
    });

    // Cleanup subscription on unmount
    return () => {
      console.log('[App.js] Unsubscribing from auth state changes.');
      unsubscribe();
    };
  }, []); // Empty dependency array means this effect runs once on mount and cleans up on unmount

  if (isLoading) {
    console.log('[App.js] Rendering: Loading screen');
    return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center text-xl">Loading Application...</div>;
  }

  if (!user) {
    console.log('[App.js] Rendering: AuthView (no user)');
    return <AuthView />;
  }

  // User is logged in, now check if setup is complete
  if (isSetupComplete) {
    console.log('[App.js] Rendering: DashboardView (user logged in, setup complete)');
    return <DashboardView />;
  } else {
    console.log('[App.js] Rendering: SetupView (user logged in, setup NOT complete)');
    // Pass a function to SetupView so it can tell App.js when setup is done
    return <SetupView onSetupComplete={() => {
      console.log('[App.js] SetupView reported setup complete. Updating state.');
      setIsSetupComplete(true);
      // Optionally, you might want to re-fetch or confirm, but for now, direct update is fine.
    }} />;
  }
}