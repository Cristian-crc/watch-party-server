const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

// ==================== CONFIGURACIÓN ====================
const PORT = process.env.PORT || 10000;

// ==================== ALMACENAMIENTO EN MEMORIA ====================
const rooms = new Map(); // roomCode -> { roomInfo, participants: Map<userId, ws> }
const connections = new Map(); // ws -> { userId, roomCode, username, isHost }
const userSessions = new Map(); // userId -> { username, currentRoom }

// ==================== FUNCIONES DE SALAS ====================
function createRoom(roomCode, roomName, hostUserId, hostUsername, videoId, maxParticipants = 10, isPrivate = false) {
    const room = {
        id: uuidv4(),
        room_code: roomCode,
        room_name: roomName || `Sala de ${hostUsername}`,
        host_user_id: hostUserId,
        host_username: hostUsername,
        video_id: videoId,
        max_participants: maxParticipants,
        is_private: isPrivate,
        is_active: true,
        created_at: Date.now(),
        video_current_time: 0,
        is_playing: false,
        participants: new Map(), // userId -> { ws, username, joinedAt, lastSeen, isHost }
        messages: [],
        playbackHistory: []
    };
    
    rooms.set(roomCode, room);
    return room;
}

function getRoom(roomCode) {
    return rooms.get(roomCode);
}

function joinRoom(roomCode, userId, username, ws) {
    const room = rooms.get(roomCode);
    if (!room) return null;
    
    // Verificar límite de participantes
    if (room.participants.size >= room.max_participants) {
        return { error: 'La sala está llena' };
    }
    
    const isHost = room.host_user_id === userId;
    const participant = {
        ws,
        userId,
        username,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        isHost
    };
    
    room.participants.set(userId, participant);
    return { room, participant, isHost };
}

function leaveRoom(roomCode, userId) {
    const room = rooms.get(roomCode);
    if (!room) return;
    
    room.participants.delete(userId);
    
    // Si no hay más participantes, eliminar la sala después de 5 minutos
    if (room.participants.size === 0) {
        setTimeout(() => {
            if (rooms.get(roomCode)?.participants.size === 0) {
                rooms.delete(roomCode);
                console.log(`🗑️ Sala ${roomCode} eliminada por inactividad`);
            }
        }, 300000); // 5 minutos
    }
}

// ==================== MANEJO DE WEBSOCKET ====================
const server = http.createServer((req, res) => {
    // Endpoint de salud para Render
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            rooms: rooms.size,
            connections: connections.size 
        }));
        return;
    }
    
    // Endpoint para obtener información de salas públicas
    if (req.url === '/public-rooms') {
        const publicRooms = Array.from(rooms.values())
            .filter(room => !room.is_private && room.participants.size > 0)
            .map(room => ({
                room_code: room.room_code,
                room_name: room.room_name,
                host_username: room.host_username,
                participant_count: room.participants.size,
                max_participants: room.max_participants,
                video_id: room.video_id,
                created_at: room.created_at
            }));
        
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, rooms: publicRooms }));
        return;
    }
    
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

const wss = new WebSocket.Server({ server, path: '/watch-party' });

wss.on('connection', (ws, req) => {
    console.log('🔌 Nueva conexión WebSocket');
    
    const query = url.parse(req.url, true).query;
    const roomCode = query.room;
    const userId = query.user;
    const username = query.username || 'Usuario';
    
    if (!roomCode || !userId) {
        ws.close(1008, 'Parámetros inválidos: se requieren room y user');
        return;
    }
    
    // Registrar conexión
    connections.set(ws, { roomCode, userId, username });
    
    // Manejar mensajes
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            await handleMessage(ws, roomCode, userId, username, message);
        } catch (error) {
            console.error('❌ Error al procesar mensaje:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Error al procesar el mensaje'
            }));
        }
    });
    
    // Manejar cierre
    ws.on('close', () => {
        console.log(`👋 ${username} (${userId}) desconectado`);
        const connectionInfo = connections.get(ws);
        if (connectionInfo) {
            leaveRoom(connectionInfo.roomCode, userId);
            connections.delete(ws);
            
            // Notificar a los demás participantes
            const room = getRoom(connectionInfo.roomCode);
            if (room) {
                broadcastToRoom(room.room_code, {
                    type: 'user_left',
                    user_id: userId,
                    username: username,
                    timestamp: Date.now()
                }, ws);
                
                // Actualizar lista de participantes
                broadcastToRoom(room.room_code, {
                    type: 'participants_update',
                    participants: getRoomParticipants(room.room_code)
                });
            }
        }
    });
    
    // Manejar errores
    ws.on('error', (error) => {
        console.error('❌ Error en WebSocket:', error);
    });
    
    // Enviar confirmación de conexión
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Conectado al servidor Watch Party',
        room: roomCode,
        user: { id: userId, username }
    }));
});

// ==================== MANEJO DE MENSAJES ====================
async function handleMessage(ws, roomCode, userId, username, message) {
    console.log(`📨 Mensaje de ${username} (${userId}) en ${roomCode}: ${message.type}`);
    
    switch (message.type) {
        case 'join':
            await handleJoin(ws, roomCode, userId, username, message);
            break;
            
        case 'chat_message':
            await handleChatMessage(roomCode, userId, username, message);
            break;
            
        case 'playback_update':
            await handlePlaybackUpdate(roomCode, userId, username, message);
            break;
            
        case 'participants_request':
            handleParticipantsRequest(ws, roomCode);
            break;
            
        case 'invite_user':
            await handleInviteUser(roomCode, userId, username, message);
            break;
            
        case 'remove_participant':
            await handleRemoveParticipant(roomCode, userId, message);
            break;
            
        case 'promote_to_cohost':
            await handlePromoteToCohost(roomCode, userId, message);
            break;
            
        case 'sync_request':
            handleSyncRequest(ws, roomCode);
            break;
            
        default:
            console.warn(`⚠️ Tipo de mensaje desconocido: ${message.type}`);
    }
}

async function handleJoin(ws, roomCode, userId, username, message) {
    let room = getRoom(roomCode);
    let isHost = false;
    
    // Si la sala no existe, crearla
    if (!room) {
        if (message.create) {
            room = createRoom(
                roomCode,
                message.room_name,
                userId,
                username,
                message.video_id,
                message.max_participants || 10,
                message.is_private || false
            );
            isHost = true;
            console.log(`🎉 Sala ${roomCode} creada por ${username}`);
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'La sala no existe'
            }));
            return;
        }
    }
    
    // Unirse a la sala
    const joinResult = joinRoom(roomCode, userId, username, ws);
    if (joinResult.error) {
        ws.send(JSON.stringify({
            type: 'error',
            message: joinResult.error
        }));
        return;
    }
    
    // Actualizar conexión con información de la sala
    const connectionInfo = connections.get(ws);
    if (connectionInfo) {
        connectionInfo.isHost = isHost || joinResult.isHost;
    }
    
    // Enviar información de la sala al nuevo participante
    ws.send(JSON.stringify({
        type: 'room_joined',
        room: {
            room_code: room.room_code,
            room_name: room.room_name,
            host_user_id: room.host_user_id,
            host_username: room.host_username,
            video_id: room.video_id,
            max_participants: room.max_participants,
            is_private: room.is_private,
            video_current_time: room.video_current_time,
            is_playing: room.is_playing,
            created_at: room.created_at
        },
        user: {
            id: userId,
            username: username,
            isHost: isHost || joinResult.isHost
        }
    }));
    
    // Notificar a todos sobre el nuevo participante
    broadcastToRoom(roomCode, {
        type: 'user_joined',
        user_id: userId,
        username: username,
        isHost: isHost || joinResult.isHost,
        timestamp: Date.now()
    }, ws);
    
    // Enviar lista actualizada de participantes
    broadcastToRoom(roomCode, {
        type: 'participants_update',
        participants: getRoomParticipants(roomCode)
    });
    
    // Enviar historial del chat
    if (room.messages.length > 0) {
        ws.send(JSON.stringify({
            type: 'chat_history',
            messages: room.messages.slice(-50)
        }));
    }
    
    // Enviar historial de reproducción
    if (room.playbackHistory.length > 0) {
        const lastPlayback = room.playbackHistory[room.playbackHistory.length - 1];
        ws.send(JSON.stringify({
            type: 'playback_sync',
            current_time: lastPlayback.current_time,
            is_playing: lastPlayback.is_playing,
            timestamp: lastPlayback.timestamp
        }));
    }
}

async function handleChatMessage(roomCode, userId, username, message) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    const chatMessage = {
        type: 'chat_message',
        user_id: userId,
        username: username,
        message: message.content,
        timestamp: Date.now()
    };
    
    // Guardar en memoria (máximo 100 mensajes)
    room.messages.push(chatMessage);
    if (room.messages.length > 100) {
        room.messages = room.messages.slice(-100);
    }
    
    // Transmitir a todos en la sala
    broadcastToRoom(roomCode, chatMessage);
}

async function handlePlaybackUpdate(roomCode, userId, username, message) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    // Actualizar estado de la sala
    room.video_current_time = message.current_time;
    room.is_playing = message.is_playing;
    
    // Guardar en historial (máximo 50 entradas)
    room.playbackHistory.push({
        user_id: userId,
        current_time: message.current_time,
        is_playing: message.is_playing,
        timestamp: Date.now()
    });
    
    if (room.playbackHistory.length > 50) {
        room.playbackHistory = room.playbackHistory.slice(-50);
    }
    
    // Transmitir a todos excepto al remitente
    broadcastToRoom(roomCode, {
        type: 'playback_update',
        user_id: userId,
        username: username,
        event_type: message.event_type,
        current_time: message.current_time,
        is_playing: message.is_playing,
        timestamp: Date.now()
    }, userId);
}

function handleParticipantsRequest(ws, roomCode) {
    const participants = getRoomParticipants(roomCode);
    ws.send(JSON.stringify({
        type: 'participants_list',
        participants: participants
    }));
}

async function handleInviteUser(roomCode, userId, username, message) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    // Verificar si el usuario es el host
    const participant = room.participants.get(userId);
    if (!participant?.isHost) {
        // Solo el host puede invitar
        const connection = Array.from(connections.values())
            .find(conn => conn.userId === userId && conn.roomCode === roomCode);
        
        if (connection?.ws) {
            connection.ws.send(JSON.stringify({
                type: 'error',
                message: 'Solo el anfitrión puede invitar usuarios'
            }));
        }
        return;
    }
    
    // Notificar a todos sobre la invitación
    broadcastToRoom(roomCode, {
        type: 'invitation_sent',
        from_user_id: userId,
        from_username: username,
        invitee: message.invitee,
        timestamp: Date.now()
    });
}

async function handleRemoveParticipant(roomCode, userId, message) {
    const room = getRoom(roomCode);
    if (!room || !message.target_user_id) return;
    
    // Verificar si el usuario es el host
    const remover = room.participants.get(userId);
    if (!remover?.isHost) return;
    
    // Encontrar y cerrar conexión del usuario objetivo
    const targetParticipant = room.participants.get(message.target_user_id);
    if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
        targetParticipant.ws.close(1000, 'Removido por el anfitrión');
    }
    
    // Notificar a todos
    broadcastToRoom(roomCode, {
        type: 'system_message',
        message: `El anfitrión ha removido a un participante`,
        timestamp: Date.now()
    });
}

async function handlePromoteToCohost(roomCode, userId, message) {
    const room = getRoom(roomCode);
    if (!room || !message.target_user_id) return;
    
    // Verificar si el usuario es el host
    const promoter = room.participants.get(userId);
    if (!promoter?.isHost) return;
    
    // Encontrar al usuario objetivo
    const targetParticipant = room.participants.get(message.target_user_id);
    if (targetParticipant) {
        // En este sistema simple, marcamos como co-host en el mensaje
        broadcastToRoom(roomCode, {
            type: 'system_message',
            message: `${targetParticipant.username} ha sido promovido a co-anfitrión`,
            timestamp: Date.now()
        });
    }
}

function handleSyncRequest(ws, roomCode) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    ws.send(JSON.stringify({
        type: 'playback_sync',
        current_time: room.video_current_time,
        is_playing: room.is_playing,
        timestamp: Date.now()
    }));
}

// ==================== FUNCIONES AUXILIARES ====================
function getRoomParticipants(roomCode) {
    const room = getRoom(roomCode);
    if (!room) return [];
    
    return Array.from(room.participants.values()).map(p => ({
        user_id: p.userId,
        username: p.username,
        isHost: p.isHost,
        last_seen: p.lastSeen,
        joined_at: p.joinedAt
    }));
}

function broadcastToRoom(roomCode, message, excludeUserId = null) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    const messageStr = JSON.stringify(message);
    
    room.participants.forEach((participant, userId) => {
        if (userId !== excludeUserId && participant.ws.readyState === WebSocket.OPEN) {
            participant.ws.send(messageStr);
        }
    });
}

// ==================== LIMPIEZA PERIÓDICA ====================
setInterval(() => {
    const now = Date.now();
    const inactiveThreshold = 5 * 60 * 1000; // 5 minutos
    
    // Limpiar conexiones inactivas
    connections.forEach((conn, ws) => {
        if (ws.readyState !== WebSocket.OPEN) {
            connections.delete(ws);
        }
    });
    
    // Limpiar salas vacías
    rooms.forEach((room, roomCode) => {
        if (room.participants.size === 0 && now - room.created_at > inactiveThreshold) {
            rooms.delete(roomCode);
            console.log(`🗑️ Sala ${roomCode} eliminada por inactividad`);
        }
    });
}, 60000); // Cada minuto

// ==================== INICIALIZACIÓN DEL SERVIDOR ====================
server.listen(PORT, () => {
    console.log(`🚀 Servidor WebSocket iniciado en el puerto ${PORT}`);
    console.log(`🔗 URL del servidor: ws://localhost:${PORT}/watch-party`);
    console.log(`📊 Salas activas en memoria: ${rooms.size}`);
    console.log(`🏥 Endpoint de salud: http://localhost:${PORT}/health`);
    console.log(`🌐 Endpoint salas públicas: http://localhost:${PORT}/public-rooms`);
});

// Manejar cierre limpio
process.on('SIGINT', () => {
    console.log('\n👋 Apagando servidor...');
    
    // Cerrar todas las conexiones WebSocket
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1000, 'Servidor apagándose');
        }
    });
    
    process.exit(0);
});
