// main.js (FINAL, FINAL TEST - Nuke All Security)
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      // --- THIS IS THE "NUKE" OPTION ---
      
      // 1. Disable web security (CORS, CSP)
      webSecurity: false, 
      
      // 2. Allow Node.js in the renderer (DANGEROUS)
      nodeIntegration: true, 
      
      // 3. Disable context isolation (DANGEROUS)
      contextIsolation: false 
    }
  });

  // Load the index.html of the app.
  mainWindow.loadFile('index.html');
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});