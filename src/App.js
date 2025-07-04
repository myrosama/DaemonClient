// src/App.js
import React, { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc } from 'firebase/firestore'; // Static import
import { auth } from '../firebase/config'; // Adjust path if needed

// Assuming these are in a ./views/ or similar folder relative to App.js
// If App.js is in src/ and views are in src/views/, paths would be e.g., './views/AuthView'
import AuthView from './AuthView';         // Adjust path if needed
import SetupView from './SetupView';       // Adjust path if needed
import DashboardView from './DashboardView'; // Adjust path if needed

export default function App() {
  const [user, setUser] = useState(null);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    console.log('[App.js] Subscribing to auth state changes.');
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      console.log('[App.js] Auth state changed. Current user:', currentUser ? currentUser.uid : 'No user');
      setIsLoading(true); // Set loading true while we check auth and setup

      if (currentUser && !currentUser.isAnonymous) {
        setUser(currentUser);
        const userId = currentUser.uid;
        console.log('[App.js] User is logged in. UID:', userId, 'Checking setup status...');

        try {
          const db = getFirestore(); // Initialize Firestore instance here
          // Ensure 'default-daemon-client' is the same identifier used in SetupView & DashboardView
          const appIdentifier = 'default-daemon-client'; 
          const configPath = `artifacts/${appIdentifier}/users/${userId}/config/telegram`;
          console.log('[App.js] Firestore path for config:', configPath);
          const configRef = doc(db, configPath);
          const configSnap = await getDoc(configRef);

          if (configSnap.exists() && configSnap.data().botToken) { // Check .exists() and botToken
            console.log('[App.js] Config document found with botToken. Setup complete.');
            setIsSetupComplete(true);
          } else {
            console.log('[App.js] Config document NOT found or no botToken. User needs setup.');
            setIsSetupComplete(false);
          }
        } catch (error) {
          console.error('[App.js] Error fetching user config from Firestore:', error);
          setIsSetupComplete(false);
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

    return () => {
      console.log('[App.js] Unsubscribing from auth state changes.');
      unsubscribe();
    };
  }, []); // Empty dependency array: runs once on mount, cleans up on unmount

  // Handle loading state
  if (isLoading) {
    console.log('[App.js] Rendering: Loading screen');
    return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center text-xl">Loading Application...</div>;
  }

  // Handle no user (authentication view)
  if (!user) {
    console.log('[App.js] Rendering: AuthView (no user)');
    return <AuthView />;
  }

  // User is logged in, decide between SetupView and DashboardView
  if (isSetupComplete) {
    console.log('[App.js] Rendering: DashboardView (user logged in, setup complete)');
    return <DashboardView />;
  } else {
    console.log('[App.js] Rendering: SetupView (user logged in, setup NOT complete)');
    return <SetupView onSetupComplete={() => {
      console.log('[App.js] SetupView reported setup complete. Updating state to show Dashboard.');
      setIsSetupComplete(true);
      // No need to re-fetch here; DashboardView will fetch its own specific data.
    }} />;
  }
}