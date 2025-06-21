// This script is the main entry point for the Electron application.
// It creates a desktop window and loads our React application into it.
const { app, BrowserWindow } = require('electron');
const path =require('path');
const url = require('url');

// This command disables hardware acceleration, which is a common fix for
// the blank/white/blue screen issue on some Windows systems.
app.disableHardwareAcceleration();

// We must keep a global reference to the window object. If you don't, the window
// will be closed automatically when the JavaScript object is garbage collected.
let win;

function createWindow() {
  // Create the main browser window.
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: '#111827',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false, // Required in development to load from localhost
    },
    // Prevent the window from appearing until the content is ready
    show: false
  });

  // Determine the URL to load based on the environment.
  // We use the built-in 'app.isPackaged' property. This is the correct way.
  const isDev = !app.isPackaged;

  const startUrl = isDev
    ? 'http://localhost:3000' // In development, load from the React dev server
    : url.format({ // In production, load the built HTML file
        pathname: path.join(__dirname, 'index.html'), 
        protocol: 'file:',
        slashes: true,
      });
  
  win.loadURL(startUrl);

  // --- THIS IS THE FINAL FIX ---
  // The 'did-finish-load' event is more reliable. It fires when the content
  // has actually finished rendering. We will only show the window then.
  win.webContents.on('did-finish-load', () => {
      win.show();
      // Open dev tools automatically if in development
      if (isDev) {
        win.webContents.openDevTools();
      }
  });


  // Emitted when the window is closed.
  win.on('closed', () => {
    // Dereference the window object.
    win = null;
  });
}

// This method will be called when Electron has finished initialization.
app.whenReady().then(createWindow);

// Quit when all windows are closed (for Windows & Linux).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// On macOS, re-create a window when the dock icon is clicked.
app.on('activate', () => {
  if (win === null) {
    createWindow();
  }
});
