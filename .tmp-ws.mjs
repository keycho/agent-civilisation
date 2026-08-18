import { WebSocket } from 'ws'
const url = process.argv[2] ?? 'wss://agent-civilisation-production.up.railway.app/ws/schiedam-havens'
const ws = new WebSocket(url)
let hello = null, events = []
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.type === 'hello') hello = m
  if (m.type === 'frame' || m.type === 'events') events.push(...(m.events ?? []))
  if (m.events) events.push(...m.events)
})
setTimeout(() => {
  const agents = hello?.agents ?? hello?.roster ?? []
  console.log('hello keys:', Object.keys(hello ?? {}).join(', '))
  console.log('agents in hello:', Array.isArray(agents) ? agents.length : 'n/a')
  if (Array.isArray(agents)) for (const a of agents.slice(0, 6)) console.log('   ', a.id, '=>', JSON.stringify(a.name))
  const withAgent = events.filter(e => e.agentId)
  console.log('events seen:', events.length, ' with agentId:', withAgent.length,
              ' MISSING agentName:', withAgent.filter(e => !e.agentName).length)
  for (const e of withAgent.slice(0, 8)) console.log('   ', e.id, e.type, e.agentId, '=>', JSON.stringify(e.agentName))
  process.exit(0)
}, 12000)
