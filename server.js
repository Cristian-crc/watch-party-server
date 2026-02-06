const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ==================== CONFIGURACIÓN ====================
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'gerges_watch_party_secret_key_2024';
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'if0_40890839_gerges',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// ==================== INICIALIZACIÓN ====================
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Almacenamiento en memoria para mejor rendimiento
const rooms = new Map(); // roomCode -> { roomInfo, participants: Map<userId, ws> }
const connections = new Map(); // ws -> { userId, roomCode, username }

// Pool de conexiones a la base de datos
let dbPool;

// ==================== FUNCIONES DE BASE DE DATOS ====================
async function initializeDatabase() {
  try {
    dbPool = mysql.createPool(DB_CONFIG);
    console.log('✅ Conexión a la base de datos establecida');
    
    // Verificar tablas necesarias
    await verifyTables();
  } catch (error) {
    console.error('❌ Error al conectar con la base de datos:', error.message);
    process.exit(1);
  }
}

async function verifyTables() {
  try {
    // Verificar que exista la tabla watch_parties
    const [tables] = await dbPool.query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'watch_parties'
    `, [DB_CONFIG.database]);
    
    if (tables.length === 0) {
      console.warn('⚠️  La tabla watch_parties no existe. Asegúrate de ejecutar el SQL proporcionado.');
    } else {
      console.log('✅ Tabla watch_parties verificada');
    }
  } catch (error) {
    console.error('❌ Error al verificar tablas:', error.message);
  }
}

async function getRoomFromDB(roomCode) {
  try {
    const [rows] = await dbPool.query(`
      SELECT wp.*, v.title as video_title, u.username as host_username
      FROM watch_parties wp
      LEFT JOIN videos v ON wp.video_id = v.id
      LEFT JOIN users u ON wp.host_user_id = u.id
      WHERE wp.room_code = ? AND wp.is_active = 1
    `, [roomCode]);
    
    return rows[0] || null;
  } catch (error) {
    console.error('Error al obtener sala de la BD:', error);
    return null;
  }
}

async function getUserFromDB(userId) {
  try {
    const [rows] = await dbPool.query(`
      SELECT id, username, email, subscription_type
      FROM users
      WHERE id = ? AND is_active = 1
    `, [userId]);
    
    return rows[0] || null;
  } catch (error) {
    console.error('Error al obtener usuario de la BD:', error);
    return null;
  }
}

async function updateRoomPlayback(roomCode, currentTime, isPlaying) {
  try {
    await dbPool.query(`
      UPDATE watch_parties 
      SET video_current_time = ?, is_playing = ?, updated_at = NOW()
      WHERE room_code = ?
    `, [currentTime, isPlaying ? 1 : 0, roomCode]);
  } catch (error) {
    console.error('Error al actualizar estado de reproducción:', error);
  }
}

async function saveChatMessage(roomId, userId, message, messageType = 'text') {
  try {
    await dbPool.query(`
      INSERT INTO watch_party_messages (watch_party_id, user_id, message, message_type)
      VALUES (?, ?, ?, ?)
    `, [roomId, userId, message, messageType]);
  } catch (error) {
    console.error('Error al guardar mensaje de chat:', error);
  }
}

async function updateParticipantLastSeen(roomId, userId) {
  try {
    await dbPool.query(`
      UPDATE watch_party_participants 
      SET last_seen = NOW() 
      WHERE watch_party_id = ? AND user_id = ?
    `, [roomId, userId]);
  } catch (error) {
    console.error('Error al actualizar last_seen:', error);
  }
}

// ==================== FUNCIONES DE AUTENTICACIÓN ====================
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function generateToken(userData) {
  return jwt.sign(userData, JWT_SECRET, { expiresIn: '24h' });
}

// ==================== MANEJO DE WEBSOCKET ====================
wss.on('connection', async (ws, req) => {
  console.log('🔌 Nueva conexión WebSocket');
  
  const query = url.parse(req.url, true).query;
  const roomCode = query.room;
  const userId = parseInt(query.user);
  
  // Validar parámetros
  if (!roomCode || !userId) {
    ws.close(1008, 'Parámetros inválidos');
    return;
  }
  
  // Obtener información de la sala desde la BD
  const roomInfo = await getRoomFromDB(roomCode);
  if (!roomInfo) {
    ws.close(1008, 'Sala no encontrada');
    return;
  }
  
  // Obtener información del usuario
  const userInfo = await getUserFromDB(userId);
  if (!userInfo) {
    ws.close(1008, 'Usuario no encontrado');
    return;
  }
  
  // Inicializar sala en memoria si no existe
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, {
      info: roomInfo,
      participants: new Map(),
      messages: [],
      lastActivity: Date.now()
    });
  }
  
  const room = rooms.get(roomCode);
  
  // Verificar límite de participantes
  if (room.participants.size >= roomInfo.max_participants) {
    ws.close(1008, 'La sala está llena');
    return;
  }
  
  // Agregar participante a la sala
  const participantData = {
    ws,
    userId,
    username: userInfo.username,
    joinedAt: Date.now(),
    lastSeen: Date.now()
  };
  
  room.participants.set(userId, participantData);
  connections.set(ws, { userId, roomCode, username: userInfo.username });
  
  console.log(`👤 ${userInfo.username} se unió a la sala ${roomCode} (${room.participants.size}/${roomInfo.max_participants})`);
  
  // Actualizar last_seen en BD
  await updateParticipantLastSeen(roomInfo.id, userId);
  
  // Enviar información de la sala al nuevo participante
  ws.send(JSON.stringify({
    type: 'room_info',
    room: roomInfo,
    user: {
      id: userId,
      username: userInfo.username,
      isHost: roomInfo.host_user_id === userId
    }
  }));
  
  // Notificar a todos sobre el nuevo participante
  broadcastToRoom(roomCode, {
    type: 'participants_update',
    participants: Array.from(room.participants.values()).map(p => ({
      user_id: p.userId,
      username: p.username,
      last_seen: p.lastSeen
    }))
  }, ws);
  
  // Enviar mensajes recientes del chat
  if (room.messages.length > 0) {
    const recentMessages = room.messages.slice(-50); // Últimos 50 mensajes
    ws.send(JSON.stringify({
      type: 'chat_history',
      messages: recentMessages
    }));
  }
  
  // Manejar mensajes entrantes
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      await handleMessage(ws, roomCode, userId, message);
    } catch (error) {
      console.error('❌ Error al procesar mensaje:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Error al procesar el mensaje'
      }));
    }
  });
  
  // Manejar cierre de conexión
  ws.on('close', async () => {
    console.log(`👋 ${userInfo.username} abandonó la sala ${roomCode}`);
    
    const connectionInfo = connections.get(ws);
    if (connectionInfo) {
      const { roomCode, userId, username } = connectionInfo;
      
      // Remover de la sala en memoria
      if (rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        room.participants.delete(userId);
        
        // Si la sala queda vacía, limpiarla después de un tiempo
        if (room.participants.size === 0) {
          setTimeout(() => {
            if (rooms.has(roomCode) && rooms.get(roomCode).participants.size === 0) {
              rooms.delete(roomCode);
              console.log(`🗑️  Sala ${roomCode} eliminada de memoria (vacía)`);
            }
          }, 300000); // 5 minutos
        } else {
          // Notificar a los demás sobre la salida
          broadcastToRoom(roomCode, {
            type: 'system_message',
            message: `${username} ha abandonado la sala`
          });
          
          // Actualizar lista de participantes
          broadcastToRoom(roomCode, {
            type: 'participants_update',
            participants: Array.from(room.participants.values()).map(p => ({
              user_id: p.userId,
              username: p.username,
              last_seen: p.lastSeen
            }))
          });
        }
      }
      
      connections.delete(ws);
    }
  });
  
  // Manejar errores
  ws.on('error', (error) => {
    console.error('❌ Error en WebSocket:', error);
  });
  
  // Enviar ping periódico para mantener conexión activa
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000); // Cada 30 segundos
  
  ws.on('pong', () => {
    // Actualizar lastSeen del participante
    if (rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      if (room.participants.has(userId)) {
        room.participants.get(userId).lastSeen = Date.now();
        updateParticipantLastSeen(roomInfo.id, userId);
      }
    }
  });
});

// ==================== MANEJO DE MENSAJES ====================
async function handleMessage(ws, roomCode, userId, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const participant = room.participants.get(userId);
  if (!participant) return;
  
  participant.lastSeen = Date.now();
  room.lastActivity = Date.now();
  
  switch (message.type) {
    case 'chat_message':
      await handleChatMessage(roomCode, userId, participant.username, message);
      break;
      
    case 'playback_update':
      await handlePlaybackUpdate(roomCode, userId, participant.username, message);
      break;
      
    case 'system_message':
      handleSystemMessage(roomCode, message);
      break;
      
    case 'invitation_update':
      handleInvitationUpdate(roomCode, message);
      break;
      
    case 'user_action':
      handleUserAction(roomCode, userId, participant.username, message);
      break;
      
    default:
      console.warn(`⚠️  Tipo de mensaje desconocido: ${message.type}`);
  }
}

async function handleChatMessage(roomCode, userId, username, message) {
  const room = rooms.get(roomCode);
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
  
  // Guardar en base de datos
  await saveChatMessage(room.info.id, userId, message.content);
  
  // Transmitir a todos en la sala
  broadcastToRoom(roomCode, chatMessage);
}

async function handlePlaybackUpdate(roomCode, userId, username, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  // Actualizar estado en memoria
  room.info.video_current_time = message.current_time;
  room.info.is_playing = message.is_playing;
  
  // Actualizar en base de datos
  await updateRoomPlayback(roomCode, message.current_time, message.is_playing);
  
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

function handleSystemMessage(roomCode, message) {
  broadcastToRoom(roomCode, {
    type: 'system_message',
    message: message.content,
    timestamp: Date.now()
  });
}

function handleInvitationUpdate(roomCode, message) {
  broadcastToRoom(roomCode, {
    type: 'invitation_update',
    ...message,
    timestamp: Date.now()
  });
}

function handleUserAction(roomCode, userId, username, message) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  // Verificar si el usuario es el host
  const isHost = room.info.host_user_id === userId;
  
  switch (message.action) {
    case 'remove_participant':
      if (isHost && message.target_user_id !== userId) {
        // Encontrar y cerrar conexión del usuario objetivo
        const targetParticipant = room.participants.get(message.target_user_id);
        if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
          targetParticipant.ws.close(1000, 'Removido por el anfitrión');
        }
        
        // Notificar a todos
        broadcastToRoom(roomCode, {
          type: 'system_message',
          message: `El anfitrión ha removido a un participante`
        });
      }
      break;
      
    case 'promote_to_cohost':
      if (isHost) {
        broadcastToRoom(roomCode, {
          type: 'system_message',
          message: `${username} ha sido promovido a co-anfitrión`
        });
      }
      break;
      
    case 'transfer_host':
      if (isHost) {
        room.info.host_user_id = message.new_host_id;
        broadcastToRoom(roomCode, {
          type: 'system_message',
          message: `El anfitrión ha sido transferido`
        });
      }
      break;
  }
}

// ==================== FUNCIONES AUXILIARES ====================
function broadcastToRoom(roomCode, message, excludeUserId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  
  const messageStr = JSON.stringify(message);
  
  room.participants.forEach((participant, userId) => {
    if (userId !== excludeUserId && participant.ws.readyState === WebSocket.OPEN) {
      participant.ws.send(messageStr);
    }
  });
}

function getRoomParticipants(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  
  return Array.from(room.participants.values()).map(p => ({
    user_id: p.userId,
    username: p.username,
    last_seen: p.lastSeen
  }));
}

// ==================== LIMPIEZA PERIÓDICA ====================
setInterval(() => {
  const now = Date.now();
  const inactiveThreshold = 5 * 60 * 1000; // 5 minutos
  
  rooms.forEach((room, roomCode) => {
    // Remover participantes inactivos
    room.participants.forEach((participant, userId) => {
      if (now - participant.lastSeen > inactiveThreshold) {
        console.log(`⏰ Removiendo participante inactivo: ${participant.username}`);
        if (participant.ws.readyState === WebSocket.OPEN) {
          participant.ws.close(1000, 'Inactivo por mucho tiempo');
        }
        room.participants.delete(userId);
      }
    });
    
    // Si la sala está vacía por mucho tiempo, limpiarla
    if (room.participants.size === 0 && now - room.lastActivity > inactiveThreshold) {
      rooms.delete(roomCode);
      console.log(`🗑️  Sala ${roomCode} eliminada por inactividad`);
    }
  });
}, 60000); // Ejecutar cada minuto

// ==================== INICIALIZACIÓN DEL SERVIDOR ====================
async function startServer() {
  try {
    await initializeDatabase();
    
    server.listen(PORT, () => {
      console.log(`🚀 Servidor WebSocket iniciado en el puerto ${PORT}`);
      console.log(`🔗 URL del servidor: ws://localhost:${PORT}`);
      console.log(`📊 Salas activas en memoria: ${rooms.size}`);
      console.log(`💾 Base de datos: ${DB_CONFIG.database}@${DB_CONFIG.host}`);
    });
  } catch (error) {
    console.error('❌ Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

// Manejar cierre limpio
process.on('SIGINT', () => {
  console.log('\n👋 Apagando servidor...');
  
  // Cerrar todas las conexiones WebSocket
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, 'Servidor apagándose');
    }
  });
  
  // Cerrar pool de base de datos
  if (dbPool) {
    dbPool.end();
  }
  
  process.exit(0);
});

// Iniciar servidor
startServer();

// Exportar para pruebas
module.exports = {
  server,
  wss,
  rooms,
  connections,
  broadcastToRoom,
  getRoomParticipants
};
