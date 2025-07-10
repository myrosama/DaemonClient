from flask import Flask
from threading import Thread

# Create a simple Flask app for the keep-alive server
app = Flask('')

@app.route('/')
def home():
    # This is the endpoint that UptimeRobot will ping
    return "I'm alive"

def run():
    # Run the keep-alive server on a different port (e.g., 8080)
    # Make sure this port does not conflict with your main app's port
    app.run(host='0.0.0.0', port=8080)

def keep_alive():
    """
    Creates and starts a new thread to run the keep-alive server.
    """
    t = Thread(target=run)
    t.start()
