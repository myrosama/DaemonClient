// src/firebase/config.js
import { initializeApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth'; // Added signOut
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore'; // Added Firestore imports

const firebaseConfig = {
  apiKey: "AIzaSyAS76sWZA0MTJOgpMHiY5y7y4-FkGISEmI", // Keep your actual API key
  authDomain: "daemonclient-c0625.firebaseapp.com",
  projectId: "daemonclient-c0625", // We can use this if needed
  storageBucket: "daemonclient-c0625.appspot.com",
  messagingSenderId: "424457448611",
  appId: "1:424457448611:web:bef99ed8fa6250cd7de316"
};

// Initialize Firebase app once
const app = initializeApp(firebaseConfig);

// Auth instance
const auth = getAuth(app);

// Firestore instance
const db = getFirestore(app);

// Path segment (to ensure consistency)
const appIdentifier = "default-daemon-client"; // <<< USE THIS IN BOTH App.js AND SetupView.js

export {
  app, // Export app if other modules need it directly
  auth,
  db,   // Export Firestore instance
  appIdentifier, // Export our chosen identifier
  // Auth methods
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  // Firestore methods (though components can also import these directly from 'firebase/firestore')
  doc,
  setDoc,
  getDoc,
  // You might also want to export firebaseConfig if needed elsewhere, but usually not.
};