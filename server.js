const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

// ==================== CONFIGURACIÓN ====================
const PORT = process.env.PORT || 10000;

// ==================== ALMACENAMIENTO EN MEMORIA ====================
const rooms = new Map(); // roomCode -> { roomInfo, participants: Map<userId, ws> }
const connections = new Map(); // ws -> { userId, roomCode, username, isHost }

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
        playbackHistory: [],
        lastMessageId: 0
    };
    
    rooms.set(roomCode, room);
    console.log(`🎉 Sala ${roomCode} creada por ${hostUsername}`);
    return room;
}

function getRoom(roomCode) {
    return rooms.get(roomCode);
}

function joinRoom(roomCode, userId, username, ws, isCreating = false) {
    const room = rooms.get(roomCode);
    if (!room) return null;
    
    // Verificar límite de participantes
    if (room.participants.size >= room.max_participants) {
        return { error: 'La sala está llena' };
    }
    
    const isHost = isCreating || (room.host_user_id === userId);
    const participant = {
        ws,
        userId,
        username,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        isHost
    };
    
    // Si es el creador, asegurarse de que sea host
    if (isCreating) {
        room.host_user_id = userId;
        room.host_username = username;
    }
    
    room.participants.set(userId, participant);
    return { room, participant, isHost };
}

function leaveRoom(roomCode, userId, username) {
    const room = rooms.get(roomCode);
    if (!room) return false;
    
    const participant = room.participants.get(userId);
    if (participant) {
        room.participants.delete(userId);
        
        // Si el host se va, asignar nuevo host
        if (participant.isHost && room.participants.size > 0) {
            const newHost = Array.from(room.participants.values())[0];
            newHost.isHost = true;
            room.host_user_id = newHost.userId;
            room.host_username = newHost.username;
            
            // Notificar cambio de host
            broadcastToRoom(roomCode, {
                type: 'system_message',
                message: `${newHost.username} es ahora el anfitrión`,
                timestamp: Date.now()
            });
        }
        
        // Si no hay más participantes, eliminar la sala
        if (room.participants.size === 0) {
            setTimeout(() => {
                if (rooms.get(roomCode)?.participants.size === 0) {
                    rooms.delete(roomCode);
                    console.log(`🗑️ Sala ${roomCode} eliminada por inactividad`);
                }
            }, 300000); // 5 minutos
        }
        
        return true;
    }
    
    return false;
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
        
        res.writeHead(200, { 
            'Content-Type': 'application/json', 
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
        });
        res.end(JSON.stringify({ success: true, rooms: publicRooms }));
        return;
    }
    
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

const wss = new WebSocket.Server({ 
    server, 
    path: '/watch-party',
    perMessageDeflate: false // Desactivar compresión para menor latencia
});

wss.on('connection', (ws, req) => {
    console.log('🔌 Nueva conexión WebSocket');
    
    const query = url.parse(req.url, true).query;
    const roomCode = query.room?.toUpperCase();
    const userId = query.user;
    const username = decodeURIComponent(query.username || 'Usuario');
    
    if (!roomCode || !userId) {
        ws.close(1008, 'Parámetros inválidos: se requieren room y user');
        return;
    }
    
    // Configurar heartbeat para mantener conexión activa
    let isAlive = true;
    ws.on('pong', () => {
        isAlive = true;
    });
    
    // Registrar conexión
    connections.set(ws, { roomCode, userId, username, ws });
    
    // Manejar mensajes
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            await handleMessage(ws, roomCode, userId, username, message);
        } catch (error) {
            console.error('❌ Error al procesar mensaje:', error);
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Error al procesar el mensaje'
                }));
            } catch (e) {
                console.error('No se pudo enviar error al cliente:', e);
            }
        }
    });
    
    // Manejar cierre
    ws.on('close', (code, reason) => {
        console.log(`👋 ${username} (${userId}) desconectado. Código: ${code}, Razón: ${reason || 'Sin razón'}`);
        const connectionInfo = connections.get(ws);
        if (connectionInfo) {
            const left = leaveRoom(connectionInfo.roomCode, userId, username);
            connections.delete(ws);
            
            if (left) {
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
        }
    });
    
    // Manejar errores
    ws.on('error', (error) => {
        console.error('❌ Error en WebSocket:', error);
    });
    
    // Enviar confirmación de conexión
    try {
        ws.send(JSON.stringify({
            type: 'connected',
            message: 'Conectado al servidor Watch Party',
            room: roomCode,
            user: { id: userId, username: username }
        }));
    } catch (error) {
        console.error('No se pudo enviar mensaje de conexión:', error);
    }
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
            
        case 'sync_request':
            handleSyncRequest(ws, roomCode);
            break;
            
        case 'leave':
            await handleLeave(roomCode, userId, username);
            break;
            
        default:
            console.warn(`⚠️ Tipo de mensaje desconocido: ${message.type}`);
    }
}

async function handleJoin(ws, roomCode, userId, username, message) {
    let room = getRoom(roomCode);
    let isCreating = message.create || false;
    
    // Si la sala no existe, crearla
    if (!room) {
        if (isCreating) {
            room = createRoom(
                roomCode,
                message.room_name,
                userId,
                username,
                message.video_id,
                message.max_participants || 10,
                message.is_private || false
            );
            console.log(`🎉 Sala ${roomCode} creada por ${username}`);
        } else {
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'La sala no existe'
                }));
            } catch (e) {
                console.error('No se pudo enviar error de sala inexistente:', e);
            }
            return;
        }
    } else if (room.is_private && !isCreating) {
        // Para salas privadas, solo se puede unir si se crea
        try {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Esta sala es privada. Necesitas una invitación para unirte.'
            }));
        } catch (e) {
            console.error('No se pudo enviar error de sala privada:', e);
        }
        return;
    }
    
    // Unirse a la sala
    const joinResult = joinRoom(roomCode, userId, username, ws, isCreating);
    if (joinResult && joinResult.error) {
        try {
            ws.send(JSON.stringify({
                type: 'error',
                message: joinResult.error
            }));
        } catch (e) {
            console.error('No se pudo enviar error de sala llena:', e);
        }
        return;
    }
    
    if (!joinResult) {
        console.error(`Error al unirse a la sala ${roomCode}`);
        return;
    }
    
    // Actualizar conexión con información de la sala
    const connectionInfo = connections.get(ws);
    if (connectionInfo) {
        connectionInfo.isHost = joinResult.isHost;
    }
    
    // Enviar información de la sala al nuevo participante
    try {
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
                video_current_time: room.video_current_time || 0,
                is_playing: room.is_playing || false,
                created_at: room.created_at
            },
            user: {
                id: userId,
                username: username,
                isHost: joinResult.isHost
            }
        }));
    } catch (e) {
        console.error('No se pudo enviar mensaje room_joined:', e);
    }
    
    // Notificar a todos sobre el nuevo participante (excepto al mismo)
    broadcastToRoom(roomCode, {
        type: 'user_joined',
        user_id: userId,
        username: username,
        isHost: joinResult.isHost,
        timestamp: Date.now()
    }, ws);
    
    // Enviar lista actualizada de participantes a todos
    const participantsUpdate = {
        type: 'participants_update',
        participants: getRoomParticipants(roomCode)
    };
    
    // Enviar al nuevo participante también
    try {
        ws.send(JSON.stringify(participantsUpdate));
    } catch (e) {
        console.error('No se pudo enviar participants_update al nuevo usuario:', e);
    }
    
    // Enviar también a los demás
    broadcastToRoom(roomCode, participantsUpdate, ws);
    
    // Enviar historial del chat (últimos 50 mensajes)
    if (room.messages && room.messages.length > 0) {
        try {
            ws.send(JSON.stringify({
                type: 'chat_history',
                messages: room.messages.slice(-50).map(msg => ({
                    ...msg,
                    timestamp: msg.timestamp || Date.now()
                }))
            }));
        } catch (e) {
            console.error('No se pudo enviar historial de chat:', e);
        }
    }
    
    // Enviar estado actual de reproducción
    if (room.video_current_time !== undefined) {
        try {
            ws.send(JSON.stringify({
                type: 'playback_sync',
                current_time: room.video_current_time || 0,
                is_playing: room.is_playing || false,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.error('No se pudo enviar sync de reproducción:', e);
        }
    }
}

async function handleChatMessage(roomCode, userId, username, message) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    // Validar que el mensaje tenga contenido
    if (!message.message || message.message.trim() === '') {
        return;
    }
    
    // Asegurarse de que el usuario esté en la sala
    const participant = room.participants.get(userId);
    if (!participant) {
        console.log(`Usuario ${userId} no encontrado en la sala ${roomCode}`);
        return;
    }
    
    const chatMessage = {
        id: ++room.lastMessageId,
        type: 'chat_message',
        user_id: userId,
        username: username,
        message: message.message.trim(),
        timestamp: Date.now()
    };
    
    // Guardar en memoria (máximo 200 mensajes)
    room.messages.push(chatMessage);
    if (room.messages.length > 200) {
        room.messages = room.messages.slice(-200);
    }
    
    // Transmitir a todos en la sala INCLUYENDO al remitente
    broadcastToRoom(roomCode, chatMessage);
    
    console.log(`💬 Chat en ${roomCode}: ${username}: ${message.message.substring(0, 50)}...`);
}

async function handlePlaybackUpdate(roomCode, userId, username, message) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    // Actualizar estado de la sala
    room.video_current_time = message.current_time || 0;
    room.is_playing = message.is_playing || false;
    
    // Guardar en historial (máximo 50 entradas)
    room.playbackHistory.push({
        user_id: userId,
        current_time: message.current_time || 0,
        is_playing: message.is_playing || false,
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
        event_type: message.event_type || 'update',
        current_time: message.current_time || 0,
        is_playing: message.is_playing || false,
        timestamp: Date.now()
    }, userId);
}

function handleParticipantsRequest(ws, roomCode) {
    const participants = getRoomParticipants(roomCode);
    try {
        ws.send(JSON.stringify({
            type: 'participants_list',
            participants: participants
        }));
    } catch (e) {
        console.error('No se pudo enviar lista de participantes:', e);
    }
}

function handleSyncRequest(ws, roomCode) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    try {
        ws.send(JSON.stringify({
            type: 'playback_sync',
            current_time: room.video_current_time || 0,
            is_playing: room.is_playing || false,
            timestamp: Date.now()
        }));
    } catch (e) {
        console.error('No se pudo enviar sync request:', e);
    }
}

async function handleLeave(roomCode, userId, username) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    const left = leaveRoom(roomCode, userId, username);
    if (left) {
        broadcastToRoom(roomCode, {
            type: 'user_left',
            user_id: userId,
            username: username,
            timestamp: Date.now()
        });
        
        broadcastToRoom(roomCode, {
            type: 'participants_update',
            participants: getRoomParticipants(roomCode)
        });
    }
}

// ==================== FUNCIONES AUXILIARES ====================
function getRoomParticipants(roomCode) {
    const room = getRoom(roomCode);
    if (!room) return [];
    
    return Array.from(room.participants.values()).map(p => ({
        user_id: p.userId,
        username: p.username,
        isHost: p.isHost,
        joined_at: p.joinedAt,
        last_seen: Date.now()
    }));
}

function broadcastToRoom(roomCode, message, exclude = null) {
    const room = getRoom(roomCode);
    if (!room) return;
    
    const messageStr = JSON.stringify(message);
    let sentCount = 0;
    
    room.participants.forEach((participant, userId) => {
        // Excluir si se especifica
        if (exclude) {
            if (exclude === userId) return;
            if (exclude === participant.ws) return;
        }
        
        try {
            if (participant.ws.readyState === 1) { // WebSocket.OPEN
                participant.ws.send(messageStr, (error) => {
                    if (error) {
                        console.error(`Error enviando mensaje a ${participant.username}:`, error);
                    }
                });
                sentCount++;
            } else {
                console.log(`WebSocket de ${participant.username} no está abierto`);
            }
        } catch (error) {
            console.error(`Error al enviar a ${participant.username}:`, error);
        }
    });
    
    if (sentCount > 0) {
        console.log(`📤 Broadcast en ${roomCode}: ${message.type} enviado a ${sentCount} participantes`);
    }
}

// ==================== HEARTBEAT PARA CONEXIONES ====================
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        const conn = connections.get(ws);
        if (conn && !conn.isAlive) {
            console.log(`💔 Terminando conexión inactiva de ${conn.username}`);
            ws.terminate();
            connections.delete(ws);
            return;
        }
        
        conn.isAlive = false;
        try {
            ws.ping();
        } catch (e) {
            console.error('Error en ping:', e);
        }
    });
}, 30000); // 30 segundos

// ==================== LIMPIEZA PERIÓDICA ====================
setInterval(() => {
    const now = Date.now();
    const inactiveThreshold = 10 * 60 * 1000; // 10 minutos
    
    // Limpiar conexiones cerradas
    connections.forEach((conn, ws) => {
        if (ws.readyState > 1) { // CERRADO o CERRANDO
            connections.delete(ws);
        }
    });
    
    // Limpiar salas vacías después de 10 minutos
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
    
    clearInterval(heartbeatInterval);
    
    // Cerrar todas las conexiones WebSocket
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.close(1000, 'Servidor apagándose');
        }
    });
    
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
    console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promise rechazada no manejada:', reason);
});
