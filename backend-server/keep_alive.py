from flask import Flask
from threading import Thread

# --- Initialize Flask App for Keep-Alive ---
app = Flask(__name__)


@app.route('/')
def home():
    """This route is used by the UptimeRobot or other pinging service."""
    return "Server is running."


def run():
    """Starts the keep-alive server on host 0.0.0.0 and port 8080."""
    app.run(host='0.0.0.0', port=8080)


def keep_alive():
    """Creates and starts a new thread to run the Flask server."""
    t = Thread(target=run)
    t.start()
