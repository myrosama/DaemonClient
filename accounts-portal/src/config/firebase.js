import firebase from 'firebase/compat/app'
import 'firebase/compat/auth'
import 'firebase/compat/firestore'
import 'firebase/compat/storage'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "daemonclient-c0625.firebaseapp.com",
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || "https://daemonclient-c0625-default-rtdb.firebaseio.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "daemonclient-c0625",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "daemonclient-c0625.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "424457448611",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:424457448611:web:bea9f7673fb40f137de316",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-72V5NJ7F2C"
}

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig)
}

export const auth = firebase.auth()
export const db = firebase.firestore()
export const storage = firebase.storage()
export default firebase
