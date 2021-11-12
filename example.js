const ChannelStore = require('.').Store
const Hyperswarm = require('hyperswarm')
const ram = require('random-access-memory')

main()

async function main () {
  const myStore = new ChannelStore(ram)
  const peerStore = new ChannelStore(ram)
  await myStore.ready()
  await peerStore.ready()

  const myKey = myStore.key.toString('hex')
  const peerKey = peerStore.key.toString('hex')

  const writableChannel = myStore.writable({ channel: '/' })
  const writablePrivateChannel = myStore.writable({ channel: '/', peerKey })
  const readableChannel = peerStore.readable({ channel: '/', peerKey: myKey })
  const readablePrivateChannel = peerStore.readable({ channel: '/', peerKey: myKey, private: true })

  await writableChannel.ready()
  await writablePrivateChannel.ready()
  await readableChannel.ready()
  await readablePrivateChannel.ready()

  const mySwarm = new Hyperswarm()
  await mySwarm.listen()
  mySwarm.on('connection', socket => myStore.replicate(socket))
  mySwarm.join(Buffer.alloc(32).fill('hello world'))

  const peerSwarm = new Hyperswarm()
  await peerSwarm.listen()
  peerSwarm.on('connection', socket => peerStore.replicate(socket))
  peerSwarm.join(Buffer.alloc(32).fill('hello world'))

  writableChannel.append('hello')
  writablePrivateChannel.append('i <3 u')

  console.log((await readableChannel.get(0)).toString())
  console.log((await readablePrivateChannel.get(0)).toString())
}
