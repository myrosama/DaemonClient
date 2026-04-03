import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { resolveThumbnailUrl } from './utils.js';

// Fix Leaflet default marker icon
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const MapView = ({ photos, botToken, onSelect }) => {
    if (!photos.length) {
        return (
            <div className="photos-empty">
                <div className="photos-empty-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{color:'var(--photos-text-dim)'}}>
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
                    </svg>
                </div>
                <h2>No locations found</h2>
                <p>Photos taken with GPS enabled will appear on the map.</p>
            </div>
        );
    }

    const center = [photos[0].latitude, photos[0].longitude];

    return (
        <div className="photos-map-container">
            <MapContainer center={center} zoom={5} style={{ height: '100%', width: '100%' }} scrollWheelZoom={true}>
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {photos.map(photo => (
                    <Marker key={photo.id} position={[photo.latitude, photo.longitude]}>
                        <Popup>
                            <MapPopupContent photo={photo} botToken={botToken} onSelect={onSelect} />
                        </Popup>
                    </Marker>
                ))}
            </MapContainer>
        </div>
    );
};

const MapPopupContent = ({ photo, botToken, onSelect }) => {
    const [src, setSrc] = useState(null);
    useEffect(() => {
        if (photo.thumbnail) { setSrc(photo.thumbnail); return; }
        if (photo.thumbFileId && botToken) {
            resolveThumbnailUrl(photo.thumbFileId, botToken).then(url => { if (url) setSrc(url); });
        }
    }, [photo, botToken]);

    return (
        <div className="photos-map-popup" onClick={() => onSelect(photo)} style={{ cursor: 'pointer' }}>
            {src && <img src={src} alt={photo.fileName} />}
            <p><strong>{photo.fileName}</strong></p>
            {photo.camera && <p>{photo.camera}</p>}
        </div>
    );
};

export default MapView;
