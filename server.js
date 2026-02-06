const WebSocket = require('ws');
const http = require('http');
const url = require('url');
require('dotenv').config();

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

// Manejo de salas
const rooms = new Map();

wss.on('connection', (ws, req) => {
    const parameters = url.parse(req.url, true).query;
    const roomCode = parameters.room;
    const userId = parameters.user;
    
    if (!roomCode || !userId) {
        ws.close(1008, 'Missing room or user parameters');
        return;
    }
    
    // Agregar a la sala
    if (!rooms.has(roomCode)) {
        rooms.set(roomCode, new Set());
    }
    
    const room = rooms.get(roomCode);
    room.add({ ws, userId, roomCode });
    
    console.log(`User ${userId} joined room ${roomCode}. Room size: ${room.size}`);
    
    // Notificar a otros usuarios
    broadcastToRoom(roomCode, {
        type: 'user_joined',
        user_id: userId,
        timestamp: Date.now()
    }, userId);
    
    // Enviar lista actual de participantes
    const participants = Array.from(room).map(p => ({
        user_id: p.userId,
        connected: p.ws.readyState === WebSocket.OPEN
    }));
    
    ws.send(JSON.stringify({
        type: 'participants_update',
        participants: participants,
        room_code: roomCode
    }));
    
    // Manejar mensajes
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleMessage(ws, roomCode, userId, data);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });
    
    // Manejar desconexión
    ws.on('close', () => {
        if (rooms.has(roomCode)) {
            const room = rooms.get(roomCode);
            
            // Remover usuario
            for (let participant of room) {
                if (participant.ws === ws) {
                    room.delete(participant);
                    break;
                }
            }
            
            console.log(`User ${userId} left room ${roomCode}. Room size: ${room.size}`);
            
            // Notificar a otros usuarios
            broadcastToRoom(roomCode, {
                type: 'user_left',
                user_id: userId,
                timestamp: Date.now()
            });
            
            // Limpiar sala si está vacía
            if (room.size === 0) {
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted (empty)`);
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

function handleMessage(ws, roomCode, userId, data) {
    if (!rooms.has(roomCode)) return;
    
    const room = rooms.get(roomCode);
    
    switch (data.type) {
        case 'chat_message':
            // Agregar timestamp y user info
            data.timestamp = Date.now();
            data.user_id = userId;
            
            // Broadcast a todos en la sala
            broadcastToRoom(roomCode, data);
            break;
            
        case 'playback_update':
            // Reenviar a todos excepto al remitente
            broadcastToRoom(roomCode, data, userId);
            break;
            
        case 'system_message':
            broadcastToRoom(roomCode, data);
            break;
    }
}

function broadcastToRoom(roomCode, message, excludeUserId = null) {
    if (!rooms.has(roomCode)) return;
    
    const room = rooms.get(roomCode);
    const messageStr = JSON.stringify(message);
    
    room.forEach(participant => {
        if (participant.ws.readyState === WebSocket.OPEN && 
            participant.userId !== excludeUserId) {
            participant.ws.send(messageStr);
        }
    });
}

// Iniciar servidor
const PORT = process.env.PORT || 8080;
console.log(`WebSocket server running on port ${PORT}`);
