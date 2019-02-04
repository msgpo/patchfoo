var http = require('http')
var memo = require('asyncmemo')
var lru = require('hashlru')
var pkg = require('../package')
var u = require('./util')
var pull = require('pull-stream')
var multicb = require('multicb')
var paramap = require('pull-paramap')
var Contacts = require('./contacts')
var PrivateBox = require('private-box')
var About = require('./about')
var Follows = require('./follows')
var Serve = require('./serve')
var Render = require('./render')
var Git = require('ssb-git')
var cat = require('pull-cat')
var proc = require('child_process')
var toPull = require('stream-to-pull-stream')
var BoxStream = require('pull-box-stream')
var crypto = require('crypto')
var SsbNpmRegistry = require('ssb-npm-registry')
var os = require('os')
var path = require('path')
var fs = require('fs')
var mkdirp = require('mkdirp')
var Base64URL = require('base64-url')
var ssbKeys = require('ssb-keys')

var zeros = new Buffer(24); zeros.fill(0)

module.exports = App

function App(sbot, config) {
  this.sbot = sbot
  this.config = config

  var conf = config.patchfoo || {}
  this.port = conf.port || 8027
  this.host = conf.host || 'localhost'
  this.msgFilter = conf.filter == null ? 'all' : conf.filter
  this.showPrivates = conf.showPrivates == null ? true : conf.showPrivates
  this.previewVotes = conf.previewVotes == null ? false : conf.previewVotes
  this.previewContacts = conf.previewContacts == null ? false : conf.previewContacts
  this.useOoo = conf.ooo == null ? false : conf.ooo
  this.ssbPort = 8008
  /*
  var capsConfig = config.caps || {}
  this.userInviteCap = capsConfig.userInvite
    || new Buffer('MxiG/9q04kN2C6vJQKa6ZhAj0G/FdfRkmeGTMnpsoek=', 'base64')
    */

  var host1 = /:/.test(this.host) ? '[' + this.host + ']' : this.host
  this.baseUrl = 'http://' + host1 + ':' + this.port
  this.dir = path.join(config.path, conf.dir || 'patchfoo')
  this.scriptDir = path.join(this.dir, conf.scriptDir || 'script')
  this.draftsDir = path.join(this.dir, conf.draftsDir || 'drafts')

  var base = conf.base || '/'
  this.opts = {
    base: base,
    blob_base: conf.blob_base || conf.img_base || base,
    img_base: conf.img_base || (base + 'image/'),
    emoji_base: conf.emoji_base || (base + 'emoji/'),
    encode_msgids: conf.encode_msgids == null ? true : Boolean(conf.encode_msgids),
    codeInTextareas: conf.codeInTextareas,
  }

  this.msgCache = lru(100)
  this.getMsg = memo({cache: this.msgCache}, getMsgWithValue, sbot)
  this.getMsgOoo = memo({cache: this.msgCache}, this.getMsgOoo)
  this.getAbout = memo({cache: this.aboutCache = lru(500)},
    this._getAbout.bind(this))
  this.unboxContent = memo({cache: lru(100)}, this.unboxContent.bind(this))
  this.reverseNameCache = lru(500)
  this.reverseEmojiNameCache = lru(500)
  this.getBlobSize = memo({cache: this.blobSizeCache = lru(100)},
    sbot.blobs.size.bind(sbot.blobs))
  this.getVotes = memo({cache: lru(100)}, this._getVotes.bind(this))
  this.getIdeaTitle = memo({cache: lru(100)}, this.getIdeaTitle)

  this.unboxMsg = this.unboxMsg.bind(this)

  this.render = new Render(this, this.opts)
  this.git = new Git(this.sbot, this.config)
  this.contacts = new Contacts(this.sbot)
  this.follows = new Follows(this.sbot, this.contacts)
  this.about = new About(this, sbot.id, this.follows)
  this.serveSsbNpmRegistry = SsbNpmRegistry.respond(this.sbot, this.config)

  this.mtimes = {}
  this.getScript = memo({cache: false}, this.getScript)

  this.monitorBlobWants()
  this.navLinks = conf.nav || [
    'new',
    'public',
    this.sbot.private && 'private',
    'mentions',
    'peers',
    this.sbot.status && 'status',
    'channels',
    'tags',
    'friends',
    'search',
    'live',
    'compose',
    'drafts',
    'emojis',
    'self',
    'searchbox'
  ]
}

App.prototype.go = function () {
  var self = this
  var server = http.createServer(function (req, res) {
    new Serve(self, req, res).go()
  })
  server.listen(self.port, self.host, onListening)
  function onListening() {
    var addr = server.address()
    var host = addr.family === 'IPv6' ? '[' + addr.address + ']' : addr.address
    self.log('Listening on http://' + host + ':' + addr.port)
  }

  // invalidate cached About info when new About messages come in
  if (!self.sbot.links) return console.error('missing sbot.links')
  else pull(
    self.sbot.links({rel: 'about', old: false, values: true}),
    pull.drain(function (link) {
      self.aboutCache.remove(link.dest)
    }, function (err) {
      if (err) throw err
    })
  )

  // keep alive ssb client connection
  setInterval(self.sbot.whoami, 10e3)
}

var logPrefix = '[' + pkg.name + ']'
App.prototype.log = console.log.bind(console, logPrefix)
App.prototype.error = console.error.bind(console, logPrefix)

App.prototype.unboxContent = function (content, cb) {
  if (this.sbot.private && this.sbot.private.unbox) return this.sbot.private.unbox(content, cb)
  if (typeof content !== 'string') return cb(new TypeError('content must be string'))
  // Missing ssb-private and privat key
  var keys = this.config.keys || {}
  if (!keys.private) {
    // Missing ssb-private and private key, so cannot decrypt here.
    // ssb-server may do decryption anyway, with private:true RPC option.
    return cb(null, null)
  }
  var data
  try { data = ssbKeys.unbox(content, this.config.keys.private) }
  catch(e) { return cb(e) }
  cb(null, data)
}

App.prototype.unboxContentWithKey = function (content, key, cb) {
  if (!key) return this.unboxContent(content, cb)
  var data
  try {
    var contentBuf = new Buffer(content.replace(/\.box.*$/, ''), 'base64')
    var keyBuf = new Buffer(key, 'base64')
    data = PrivateBox.multibox_open_body(contentBuf, keyBuf)
    if (!data) return cb(new Error('failed to decrypt'))
    data = JSON.parse(data.toString('utf8'))
  } catch(e) {
    return cb(new Error(e.stack || e))
  }
  cb(null, data)
}

App.prototype.unboxMsgWithKey = function (msg, key, cb) {
  var self = this
  var c = msg && msg.value && msg.value.content
  if (typeof c !== 'string') cb(null, msg)
  else self.unboxContentWithKey(c, key, function (err, content) {
    if (err) {
      self.error('unbox:', err)
      return cb(null, msg)
    } else if (!content) {
      return cb(null, msg)
    }
    var m = {}
    for (var k in msg) m[k] = msg[k]
    m.value = {}
    for (var k in msg.value) m.value[k] = msg.value[k]
    m.value.content = content
    m.value.private = true
    cb(null, m)
  })
}

App.prototype.unboxMsg = function (msg, cb) {
  return this.unboxMsgWithKey(msg, null, cb)
}

App.prototype.search = function (opts) {
  var fsearch = this.sbot.fulltext && this.sbot.fulltext.search
  if (fsearch) return fsearch(opts)
  var search = this.sbot.search && this.sbot.search.query
  if (search) return search({query: opts})
  return pull.error(new Error('Search needs ssb-fulltext or ssb-search plugin'))
}

App.prototype.advancedSearch = function (opts) {
  return pull(
    opts.channel ?
      this.sbot.backlinks.read({
        dest: '#' + opts.channel,
        reverse: true,
      })
    : opts.dest ?
      this.sbot.links({
        values: true,
        dest: opts.dest,
        source: opts.source || undefined,
        reverse: true,
        meta: false,
      })
    : opts.source ?
      this.sbotCreateUserStream({
        reverse: true,
        id: opts.source
      })
    :
      this.sbot.createFeedStream({
        reverse: true,
      }),
    this.unboxMessages(),
    opts.text && pull.filter(filterByText(opts.text))
  )
}

function forSome(each) {
  return function some(obj) {
    if (obj == null) return false
    if (typeof obj === 'string') return each(obj)
    if (Array.isArray(obj)) return obj.some(some)
    if (typeof obj === 'object')
      for (var k in obj) if (some(obj[k])) return true
    return false
  }
}

function filterByText(str) {
  if (!str) return function () { return true }
  var search = new RegExp(str, 'i')
  var matches = forSome(search.test.bind(search))
  return function (msg) {
    var c = msg.value.content
    return c && matches(c)
  }
}

App.prototype.getMsgDecrypted = function (key, cb) {
  var self = this
  this.getMsg(key, function (err, msg) {
    if (err) return cb(err)
    self.unboxMsg(msg, cb)
  })
}

App.prototype.getMsgOoo = function (key, cb) {
  var ooo = this.sbot.ooo
  if (!ooo) return cb(new Error('missing ssb-ooo plugin'))
  ooo.get(key, cb)
}

App.prototype.getMsgDecryptedOoo = function (key, cb) {
  var self = this
  this.getMsgOoo(key, function (err, msg) {
    if (err) return cb(err)
    self.unboxMsg(msg, cb)
  })
}

App.prototype.publishMayRedirect = function (content, cb) {
  var publishguard = this.sbot.publishguard
  if (Array.isArray(content.recps)) {
    var recps = content.recps.map(u.linkDest)
    if (publishguard && publishguard.privatePublishGetUrl) {
      return publishguard.privatePublishGetUrl({
        content: content,
        recps: recps,
        redirectBase: this.baseUrl + '/'
      }, onPublishGetUrl)
    }
    this.privatePublish(content, recps, cb)
  } else {
    if (publishguard && publishguard.publishGetUrl) {
      return publishguard.publishGetUrl({
        content: content,
        redirectBase: this.baseUrl + '/'
      }, onPublishGetUrl)
    }
    this.sbot.publish(content, cb)
  }
  function onPublishGetUrl(err, url) {
    if (err) return cb(err)
    cb({redirectUrl: url})
  }
}

App.prototype.privatePublish = function (content, recps, cb) {
  if (this.private && typeof this.private.publish === 'function') {
    return this.sbot.private.publish(content, recps, cb)
  } else {
    try { content = ssbKeys.box(content, recps) }
    catch(e) { return cb(e) }
    return this.sbot.publish(content, cb)
  }
}

App.prototype.publish = function (content, cb) {
  var self = this
  function tryPublish(triesLeft) {
    if (Array.isArray(content.recps)) {
      var recps = content.recps.map(u.linkDest)
      self.privatePublish(content, recps, next)
    } else {
      self.sbot.publish(content, next)
    }
    function next(err, msg) {
      if (err) {
        if (triesLeft > 0) {
          if (/^expected previous:/.test(err.message)) {
            return tryPublish(triesLeft-1)
          }
        }
      }
      return cb(err, msg)
    }
  }
  tryPublish(2)
}

App.prototype.wantSizeBlob = function (id, cb) {
  // only want() the blob if we don't already have it
  var self = this
  var blobs = this.sbot.blobs
  blobs.size(id, function (err, size) {
    if (size != null) return cb(null, size)
    self.blobWants[id] = true
    blobs.want(id, function (err) {
      if (err) return cb(err)
      blobs.size(id, cb)
    })
  })
}

App.prototype.addBlobRaw = function (cb) {
  var done = multicb({pluck: 1, spread: true})
  var sink = pull(
    u.pullLength(done()),
    this.sbot.blobs.add(done())
  )
  done(function (err, size, hash) {
    if (err) return cb(err)
    cb(null, {link: hash, size: size})
  })
  return sink
}

App.prototype.addBlob = function (isPrivate, cb) {
  if (!isPrivate) return this.addBlobRaw(cb)
  else return this.addBlobPrivate(cb)
}

App.prototype.addBlobPrivate = function (cb) {
  var bufs = []
  var self = this
  // use the hash of the cleartext as the key to encrypt the blob
  var hash = crypto.createHash('sha256')
  return pull.drain(function (buf) {
    bufs.push(buf)
    hash.update(buf)
  }, function (err) {
    if (err) return cb(err)
    var secret = hash.digest()
    pull(
      pull.values(bufs),
      BoxStream.createBoxStream(secret, zeros),
      self.addBlobRaw(function (err, link) {
        if (err) return cb(err)
        link.key = secret.toString('base64')
        cb(null, link)
      })
    )
  })
}

App.prototype.getBlob = function (id, key) {
  if (!key) return this.sbot.blobs.get(id)
  if (typeof key === 'string') key = new Buffer(key, 'base64')
  return pull(
    this.sbot.blobs.get(id),
    BoxStream.createUnboxStream(key, zeros)
  )
}

App.prototype.pushBlob = function (id, cb) {
  console.error('pushing blob', id)
  this.sbot.blobs.push(id, cb)
}

App.prototype.readBlob = function (link) {
  link = u.toLink(link)
  return this.sbot.blobs.get({
    hash: link.link,
    size: link.size,
  })
}

App.prototype.readBlobSlice = function (link, opts) {
  if (this.sbot.blobs.getSlice) return this.sbot.blobs.getSlice({
    hash: link.link,
    size: link.size,
    start: opts.start,
    end: opts.end,
  })
  return pull(
    this.readBlob(link),
    u.pullSlice(opts.start, opts.end)
  )
}

App.prototype.ensureHasBlobs = function (links, cb) {
  var self = this
  var done = multicb({pluck: 1})
  links.filter(Boolean).forEach(function (link) {
    var cb = done()
    self.sbot.blobs.size(link.link, function (err, size) {
      if (err) cb(err)
      else if (size == null) cb(null, link)
      else cb()
    })
  })
  done(function (err, missingLinks) {
    if (err) console.trace(err)
    missingLinks = missingLinks.filter(Boolean)
    if (missingLinks.length == 0) return cb()
    return cb({name: 'BlobNotFoundError', links: missingLinks})
  })
}

App.prototype.getReverseNameSync = function (name) {
  var id = this.reverseNameCache.get(name)
  return id
}

App.prototype.getReverseEmojiNameSync = function (name) {
  return this.reverseEmojiNameCache.get(name)
}

App.prototype.getNameSync = function (name) {
  var about = this.aboutCache.get(name)
  return about && about.name
}

function sbotGet(sbot, id, cb) {
  // ssb-ooo@1.0.1 (a50da3928500f3ac0fbead0a1b335a3dd5bbc096): raw=true
  // ssb-ooo@1.1.0 (f7302d12e56d566b84205bbc0c8b882ae6fd9b12): ooo=false
  if (sbot.ooo) {
    sbot.get({id: id, raw: true, ooo: false, private: true}, cb)
  } else {
    if (!sbot.private) {
      // if no sbot.private, assume we have newer sbot that supports private:true
      return sbot.get({id: id, private: true}, cb)
    }
    sbot.get(id, cb)
  }
}

function getMsgWithValue(sbot, id, cb) {
  if (!id) return cb()
  sbotGet(sbot, id, function (err, value) {
    if (err) return cb(err)
    cb(null, {key: id, value: value})
  })
}

App.prototype._getAbout = function (id, cb) {
  var self = this
  if (!u.isRef(id)) return cb(null, {})
  self.about.get(id, function (err, about) {
    if (err) return cb(err)
    var sigil = id[0] || '@'
    if (about.name && about.name[0] !== sigil) {
      about.name = sigil + about.name
    }
    self.reverseNameCache.set(about.name, id)
    cb(null, about)
  })
}

App.prototype.pullGetMsg = function (id) {
  return pull.asyncMap(this.getMsg)(pull.once(id))
}

App.prototype.createLogStream = function (opts) {
  opts = opts || {}
  return opts.sortByTimestamp
    ? this.createFeedStream(opts)
    : this.sbot.createLogStream(opts)
}

App.prototype.createFeedStream = function (opts) {
  // work around opts.gt being treated as opts.gte sometimes
  return pull(
    this.sbot.createFeedStream(opts),
    pull.filter(function (msg) {
      var ts = msg && msg.value && msg.value.timestamp
      return typeof ts === 'number' && ts !== opts.gt && ts !== opts.lt
    })
  )
}

var stateVals = {
  connected: 3,
  connecting: 2,
  disconnecting: 1,
}

function comparePeers(a, b) {
  var aState = stateVals[a.state] || 0
  var bState = stateVals[b.state] || 0
  return (bState - aState)
    || (b.stateChange|0 - a.stateChange|0)
}

App.prototype.streamPeers = function (opts) {
  var gossip = this.sbot.gossip
  return u.readNext(function (cb) {
    gossip.peers(function (err, peers) {
      if (err) return cb(err)
      if (opts) peers = peers.filter(function (peer) {
        for (var k in opts) if (opts[k] !== peer[k]) return false
        return true
      })
      peers.sort(comparePeers)
      cb(null, pull.values(peers))
    })
  })
}

App.prototype.getContact = function (source, dest, cb) {
  var self = this
  pull(
    self.sbot.links({source: source, dest: dest, rel: 'contact', reverse: true,
      values: true, meta: false, keys: false}),
    pull.filter(function (value) {
      var c = value && !value.private && value.content
      return c && c.type === 'contact'
    }),
    pull.take(1),
    pull.reduce(function (acc, value) {
      // trinary logic from ssb-friends
      return value.content.following ? true
        : value.content.flagged || value.content.blocking ? false
        : null
    }, null, cb)
  )
}

App.prototype.isMuted = function (id, cb) {
  var self = this
  pull(
    self.sbot.links({source: self.sbot.id, dest: id, rel: 'contact', reverse: true,
      values: true, meta: false}), // meta:false to emulate private:true
    pull.filter(function (msg) {
      return msg && msg.value && typeof msg.value.content === 'string'
    }),
    this.unboxMessages(),
    pull.filter(function (msg) {
      var c = msg && msg.value && msg && msg.value.content
      return c && c.type === 'contact'
    }),
    pull.take(1),
    pull.reduce(function (acc, msg) {
      var c = msg && msg.value && msg.value.content
      return c.following ? false : c.flagged || c.blocking ? true : null
    }, null, cb)
  )
}

App.prototype.unboxMessages = function () {
  return paramap(this.unboxMsg, 16)
}

App.prototype.streamChannels = function (opts) {
  return pull(
    this.sbotMessagesByType({type: 'channel', reverse: true}),
    this.unboxMessages(),
    pull.filter(function (msg) {
      return msg.value.content.subscribed
    }),
    pull.map(function (msg) {
      return msg.value.content.channel
    }),
    pull.unique()
  )
}

App.prototype.streamMyChannels = function (id, opts) {
  // use ssb-query plugin if it is available, since it has an index for
  // author + type
  if (this.sbot.query) return pull(
    this.sbot.query.read({
      reverse: true,
      query: [
        {$filter: {
          value: {
            author: id,
            content: {type: 'channel'}
          }
        }},
        {$map: ['value', 'content']}
      ]
    }),
    pull.unique('channel'),
    pull.filter('subscribed'),
    pull.map('channel')
  )

  return pull(
    this.sbotCreateUserStream({id: id, reverse: true}),
    this.unboxMessages(),
    pull.map(function (msg) {
      return msg.value.content
    }),
    pull.filter(function (c) {
      return c.type === 'channel'
    }),
    pull.unique('channel'),
    pull.filter('subscribed'),
    pull.map('channel')
  )
}

App.prototype.streamTags = function () {
  return pull(
    this.sbotMessagesByType({type: 'tag', reverse: true}),
    this.unboxMessages(),
    pull.filter(function (msg) {
      return !msg.value.content.message
    })
  )
}

function compareVoted(a, b) {
  return b.value - a.value
}

App.prototype.getVoted = function (_opts, cb) {
  if (isNaN(_opts.limit)) return pull.error(new Error('missing limit'))
  var self = this
  var opts = {
    type: 'vote',
    limit: _opts.limit * 100,
    reverse: !!_opts.reverse,
    gt: _opts.gt || undefined,
    lt: _opts.lt || undefined,
  }

  var votedObj = {}
  var votedArray = []
  var numItems = 0
  var firstTimestamp, lastTimestamp
  pull(
    self.sbotMessagesByType(opts),
    self.unboxMessages(),
    pull.take(function () {
      return numItems < _opts.limit
    }),
    pull.drain(function (msg) {
      if (!firstTimestamp) firstTimestamp = msg.timestamp
      lastTimestamp = msg.timestamp
      var vote = msg.value.content.vote
      if (!vote) return
      var target = u.linkDest(vote)
      var votes = votedObj[target]
      if (!votes) {
        numItems++
        votes = {id: target, value: 0, feedsObj: {}, feeds: []}
        votedObj[target] = votes
        votedArray.push(votes)
      }
      if (msg.value.author in votes.feedsObj) {
        if (!opts.reverse) return // leave latest vote value as-is
        // remove old vote value
        votes.value -= votes.feedsObj[msg.value.author]
      } else {
        votes.feeds.push(msg.value.author)
      }
      var value = vote.value > 0 ? 1 : vote.value < 0 ? -1 : 0
      votes.feedsObj[msg.value.author] = value
      votes.value += value
    }, function (err) {
      if (err && err !== true) return cb(err)
      var items = votedArray
      if (opts.reverse) items.reverse()
      items.sort(compareVoted)
      cb(null, {items: items,
        firstTimestamp: firstTimestamp,
        lastTimestamp: lastTimestamp})
    })
  )
}

App.prototype.createAboutStreams = function (id) {
  return this.about.createAboutStreams(id)
}

App.prototype.streamEmojis = function () {
  return pull(
    cat([
      this.sbot.links({
        rel: 'mentions',
        source: this.sbot.id,
        dest: '&',
        values: true,
        meta: false // emulate private:true
      }),
      this.sbot.links({rel: 'mentions', dest: '&', values: true, meta: false})
    ]),
    this.unboxMessages(),
    pull.map(function (msg) { return msg.value.content.mentions }),
    pull.flatten(),
    pull.filter('emoji'),
    pull.unique('link')
  )
}

App.prototype.filter = function (plugin, opts, filter) {
  // work around flumeview-query not picking the best index.
  // %b+QdyLFQ21UGYwvV3AiD8FEr7mKlB8w9xx3h8WzSUb0=.sha256
  var limit = Number(opts.limit)
  var index
  if (plugin === this.sbot.backlinks) {
    var c = filter && filter.value && filter.value.content
    var filteringByType = c && c.type
    if (opts.sortByTimestamp) index = 'DTA'
    else if (filteringByType) index = 'DTS'
  }
  var filterOpts = {
    $gt: opts.gt,
    $lt: opts.lt,
  }
  return plugin.read({
    index: index,
    reverse: opts.reverse,
    limit: limit || undefined,
    query: [{$filter: u.mergeOpts(filter, opts.sortByTimestamp ? {
      value: {
        timestamp: filterOpts
      }
    } : {
      timestamp: filterOpts
    })}]
  })
}

App.prototype.filterMessages = function (opts) {
  var self = this
  var limit = Number(opts.limit)
  return pull(
    paramap(function (msg, cb) {
      self.filterMsg(msg, opts, function (err, show) {
        if (err) return cb(err)
        cb(null, show ? msg : null)
      })
    }, 4),
    pull.filter(Boolean),
    limit && pull.take(limit)
  )
}

App.prototype.streamChannel = function (opts) {
  // prefer ssb-backlinks to ssb-query because it also handles hashtag mentions
  if (this.sbot.backlinks) return this.filter(this.sbot.backlinks, opts, {
    dest: '#' + opts.channel,
  })

  if (this.sbot.query) return this.filter(this.sbot.query, opts, {
    value: {content: {channel: opts.channel}},
  })

  return pull.error(new Error(
    'Viewing channels/tags requires the ssb-backlinks or ssb-query plugin'))
}

App.prototype.streamMentions = function (opts) {
  if (!this.sbot.backlinks) return pull.error(new Error(
    'Viewing mentions requires the ssb-backlinks plugin'))

  if (this.sbot.backlinks) return this.filter(this.sbot.backlinks, opts, {
    dest: this.sbot.id,
  })
}

App.prototype.streamPrivate = function (opts) {
  if (this.sbot.private && this.sbot.private.read)
    return this.filter(this.sbot.private, opts, {})

  return pull(
    this.createLogStream(u.mergeOpts(opts, {private: true})),
    pull.filter(u.isMsgEncrypted),
    this.unboxMessages(),
    pull.filter(u.isMsgReadable)
  )
}

App.prototype.blobMentions = function (opts) {
  if (!this.sbot.links2) return pull.error(new Error(
    'missing ssb-links plugin'))
  var filter = {rel: ['mentions', opts.name]}
  if (opts.author) filter.source = opts.author
  return this.sbot.links2.read({
    query: [
      {$filter: filter},
      {$filter: {dest: {$prefix: '&'}}},
      {$map: {
        name: ['rel', 1],
        size: ['rel', 2],
        link: 'dest',
        author: 'source',
        time: 'ts'
      }}
    ]
  })
}

App.prototype.monitorBlobWants = function () {
  var self = this
  self.blobWants = {}
  pull(
    this.sbot.blobs.createWants(),
    pull.drain(function (wants) {
      for (var id in wants) {
        if (wants[id] < 0) self.blobWants[id] = true
        else delete self.blobWants[id]
        self.blobSizeCache.remove(id)
      }
    }, function (err) {
      if (err) console.trace(err)
    })
  )
}

App.prototype.getBlobState = function (id, cb) {
  var self = this
  if (self.blobWants[id]) return cb(null, 'wanted')
  self.getBlobSize(id, function (err, size) {
    if (err) return cb(err)
    cb(null, size != null)
  })
}

App.prototype.getNpmReadme = function (tarballId, cb) {
  var self = this
  // TODO: make this portable, and handle plaintext readmes
  var tar = proc.spawn('tar', ['--ignore-case', '-Oxz',
    'package/README.md', 'package/readme.markdown', 'package/readme.mkd'])
  var done = multicb({pluck: 1, spread: true})
  pull(
    self.sbot.blobs.get(tarballId),
    toPull.sink(tar.stdin, done())
  )
  pull(
    toPull.source(tar.stdout),
    pull.collect(done())
  )
  done(function (err, _, bufs) {
    if (err) return cb(err)
    var text = Buffer.concat(bufs).toString('utf8')
    cb(null, text, true)
  })
}

App.prototype.filterMsg = function (msg, opts, cb) {
  var self = this
  var myId = self.sbot.id
  var author = msg.value && msg.value.author
  var filter = opts.filter || self.msgFilter
  if (filter === 'all') return cb(null, true)
  var show = (filter !== 'invert')
  var isPrivate = msg.value && typeof msg.value.content === 'string'
  if (isPrivate && !self.showPrivates) return cb(null, !show)
  if (author === myId
   || author === opts.feed
   || msg.key === opts.msgId) return cb(null, show)
  self.follows.getFollows(myId, function (err, follows) {
    if (err) return cb(err)
    if (follows[author]) return cb(null, show)
    self.getVotes(msg.key, function (err, votes) {
      if (err) return cb(err)
      for (var author in votes) {
        if (follows[author] && votes[author] > 0) {
          return cb(null, show)
        }
      }
      return cb(null, !show)
    })
  })
}

App.prototype.isFollowing = function (src, dest, cb) {
  var self = this
  self.follows.getFollows(src, function (err, follows) {
    if (err) return cb(err)
    return cb(null, follows[dest])
  })
}

App.prototype.getVotesStream = function (id) {
  var links2 = this.sbot.links2
  if (links2 && links2.read) return links2.read({
    query: [
      {$filter: {
        dest: id,
        rel: [{$prefix: 'vote'}]
      }},
      {$map: {
        value: ['rel', 1],
        author: 'source'
      }}
    ]
  })

  var backlinks = this.sbot.backlinks
  if (backlinks && backlinks.read) return backlinks.read({
    query: [
      {$filter: {
        dest: id,
        value: {
          content: {
            type: 'vote',
            vote: {
              link: id
            }
          }
        }
      }},
      {$map: {
        author: ['value', 'author'],
        value: ['value', 'content', 'vote', 'value']
      }}
    ]
  })

  return pull(
    this.sbot.links({
      dest: id,
      rel: 'vote',
      keys: false,
      meta: false,
      values: true
    }),
    pull.map(function (value) {
      var vote = value && value.content && value.content.vote
      return {
        author: value && value.author,
        vote: vote && vote.value
      }
    })
  )
}

App.prototype._getVotes = function (id, cb) {
  var votes = {}
  pull(
    this.getVotesStream(),
    pull.drain(function (vote) {
      votes[vote.author] = vote.value
    }, function (err) {
      cb(err, votes)
    })
  )
}

App.prototype.getAddresses = function (id) {
  if (!this.sbot.backlinks) {
    if (!this.warned1) {
      this.warned1 = true
      console.trace('Getting peer addresses requires the ssb-backlinks plugin')
    }
    return pull.empty()
  }

  var pubMsgAddresses = pull(
    this.sbot.backlinks.read({
      reverse: true,
      query: [
        {$filter: {
          dest: id,
          value: {
            content: {
              type: 'pub',
              address: {
                key: id,
                host: {$truthy: true},
                port: {$truthy: true},
              }
            }
          }
        }},
        {$map: ['value', 'content', 'address']}
      ]
    }),
    pull.map(function (addr) {
      return addr.host + ':' + addr.port
    })
  )

  var newerAddresses = pull(
    cat([
      this.sbot.query.read({
        reverse: true,
        limit: 1,
        query: [
          {$filter: {
            value: {
              author: id,
              content: {
                type: 'address',
                address: {$truthy: true}
              }
            }
          }},
          {$map: ['value', 'content', 'address']}
        ]
      }),
      this.sbot.query.read({
        reverse: true,
        limit: 1,
        query: [
          {$filter: {
            value: {
              author: id,
              content: {
                type: 'pub-owner-confirm',
                address: {$truthy: true}
              }
            }
          }},
          {$map: ['value', 'content', 'address']}
        ]
      })
    ]),
    pull.map(function (addr) {
      var i = addr.lastIndexOf(':' + id)
      if (i > -1 && addr.length === i + id.length + 1) {
        return addr.substr(0, i)
      }
      var m = /^(?:net|onion):([^~;]*:[0-9]*)~shs:([0-9a-zA-Z/=+]{44})/.exec(addr)
      if (m && id === '@' + m[2] + '.ed25519') {
        return m[1]
      }
      return addr
    })
  )

  return pull(
    cat([newerAddresses, pubMsgAddresses]),
    pull.unique()
  )
}

App.prototype.isPub = function (id, cb) {
  if (!this.sbot.backlinks) {
    return pull(
      this.sbot.links({
        dest: id,
        rel: 'pub'
      }),
      pull.take(1),
      pull.collect(function (err, links) {
        if (err) return cb(err)
        cb(null, links.length == 1)
      })
    )
  }
  return pull(
    this.sbot.backlinks.read({
      limit: 1,
      query: [
        {$filter: {
          dest: id,
          value: {
            content: {
              type: 'pub',
              address: {
                key: id,
                host: {$truthy: true},
                port: {$truthy: true},
              }
            }
          }
        }}
      ]
    }),
    pull.collect(function (err, msgs) {
      if (err) return cb(err)
      cb(null, msgs.length == 1)
    })
  )
}

App.prototype.getIdeaTitle = function (id, cb) {
  if (!this.sbot.backlinks) return cb(null, String(id).substr(0, 8) + '…')
  pull(
    this.sbot.backlinks.read({
      reverse: true,
      query: [
        {$filter: {
          dest: id,
          value: {
            content: {
              type: 'talenet-idea-update',
              ideaKey: id,
              title: {$truthy: true}
            }
          }
        }},
        {$map: ['value', 'content', 'title']}
      ]
    }),
    pull.take(1),
    pull.collect(function (err, titles) {
      if (err) return cb(err)
      var title = titles && titles[0]
        || (String(id).substr(0, 8) + '…')
      cb(null, title)
    })
  )
}

function traverse(obj, emit) {
  emit(obj)
  if (obj !== null && typeof obj === 'object') {
    for (var k in obj) {
      traverse(obj[k], emit)
    }
  }
}

App.prototype.expandOoo = function (opts, cb) {
  var self = this
  var dest = opts.dest
  var msgs = opts.msgs
  if (!Array.isArray(msgs)) return cb(new TypeError('msgs should be array'))

  // algorithm:
  // traverse all links in the initial message set.
  // find linked-to messages not in the set.
  // fetch those messages.
  // if one links to the dest, add it to the set
  // and look for more missing links to fetch.
  // done when no more links to fetch

  var msgsO = {}
  var getting = {}
  var waiting = 0

  function checkDone() {
    if (waiting) return
    var msgs = Object.keys(msgsO).map(function (key) {
      return msgsO[key]
    })
    cb(null, msgs)
  }

  function getMsg(id) {
    if (msgsO[id] || getting[id]) return
    getting[id] = true
    waiting++
    self.getMsgDecryptedOoo(id, function (err, msg) {
      waiting--
      if (err) console.trace(err)
      else gotMsg(msg)
      checkDone()
    })
  }

  var links = {}
  function addLink(id) {
    if (typeof id === 'string' && id[0] === '%' && u.isRef(id)) {
      links[id] = true
    }
  }

  msgs.forEach(function (msg) {
    if (msgs[msg.key]) return
    if (msg.value.content === false) return // missing root
    msgsO[msg.key] = msg
    traverse(msg, addLink)
  })
  waiting++
  for (var id in links) {
    getMsg(id)
  }
  waiting--
  checkDone()

  function gotMsg(msg) {
    if (msgsO[msg.key]) return
    var links = []
    var linkedToDest = msg.key === dest
    traverse(msg, function (id) {
      if (id === dest) linkedToDest = true
      links.push(id)
    })
    if (linkedToDest) {
      msgsO[msg.key] = msg
      links.forEach(addLink)
    }
  }
}

App.prototype.getLineComments = function (opts, cb) {
  // get line comments for a git-update message and git object id.
  // line comments include message id, commit id and path
  // but we have message id and git object hash.
  // look up the git object hash for each line-comment
  // to verify that it is for the git object file we want
  var updateId = opts.obj.msg.key
  var objId = opts.hash
  var self = this
  var lineComments = {}
  pull(
    self.sbot.backlinks ? self.sbot.backlinks.read({
      query: [
        {$filter: {
          dest: updateId,
          value: {
            content: {
              type: 'line-comment',
              updateId: updateId,
            }
          }
        }}
      ]
    }) : pull(
      self.sbot.links({
        dest: updateId,
        rel: 'updateId',
        values: true,
        meta: false,
      }),
      pull.filter(function (msg) {
        var c = msg && msg.value && msg.value.content
        return c && c.type === 'line-comment'
          && c.updateId === updateId
      })
    ),
    paramap(function (msg, cb) {
      var c = msg.value.content
      self.git.getObjectAtPath({
        msg: updateId,
        obj: c.commitId,
        path: c.filePath,
      }, function (err, info) {
        if (err) return cb(err)
        cb(null, {
          obj: info.obj,
          hash: info.hash,
          msg: msg,
        })
      })
    }, 4),
    pull.filter(function (info) {
      return info.hash === objId
    }),
    pull.drain(function (info) {
      lineComments[info.msg.value.content.line] = info
    }, function (err) {
      cb(err, lineComments)
    })
  )
}

App.prototype.sbotLinks = function (opts) {
  if (!this.sbot.links) return pull.error(new Error('missing sbot.links'))
  return this.sbot.links(opts)
}

App.prototype.sbotCreateUserStream = function (opts) {
  if (!this.sbot.createUserStream) return pull.error(new Error('missing sbot.createUserStream'))
  return this.sbot.createUserStream(opts)
}

App.prototype.sbotMessagesByType = function (opts) {
  if (!this.sbot.messagesByType) return pull.error(new Error('missing sbot.messagesByType'))
  return this.sbot.messagesByType(opts)
}

App.prototype.getThread = function (msg) {
  return cat([
    pull.once(msg),
    this.sbot.backlinks ? this.sbot.backlinks.read({
      query: [
        {$filter: {dest: msg.key}}
      ]
    }) : this.sbotLinks({
      dest: msg.key,
      meta: false,
      values: true
    })
  ])
}

App.prototype.getLinks = function (id) {
  return this.sbot.backlinks ? this.sbot.backlinks.read({
    query: [
      {$filter: {dest: id}}
    ]
  }) : this.sbotLinks({
    dest: id,
    meta: false,
    values: true
  })
}

App.prototype.getShard = function (id, cb) {
  var self = this
  this.getMsgDecrypted(id, function (err, msg) {
    if (err) return cb(new Error('Unable to get shard message: ' + err.stack))
    var c = msg.value.content || {}
    if (!c.shard) return cb(new Error('Message missing shard: ' + id))
    self.unboxContent(c.shard, function (err, shard) {
      if (err) return cb(new Error('Unable to decrypt shard: ' + err.stack))
      cb(null, shard)
    })
  })
}

App.prototype.sbotStatus = function (cb) {
  /* sbot.status is a "sync" method. if we are a plugin, it is sync. if we are
   * calling over muxrpc, it is async. */
  var status
  try {
    status = this.sbot.status(cb)
  } catch(err) {
    return cb(err)
  }
  if (typeof status === 'object' && status !== null) return cb(null, status)
}

function writeAll(fd, buf, cb) {
  var offset = 0
  var remaining = buf.length
  fs.write(fd, buf, function onWrite(err, bytesWritten) {
    if (err) return cb(err)
    offset += bytesWritten
    remaining -= bytesWritten
    if (remaining > 0) fs.write(fd, buf, offset, remaining, null, onWrite)
    else cb()
  })
}

App.prototype.verifyGitObjectSignature = function (obj, cb) {
  var self = this
  var tmpPath = path.join(os.tmpdir(), '.git_vtag_tmp' + Math.random().toString('36'))
  // use a temp file to work around https://github.com/nodejs/node/issues/13542
  function closeEnd(err) {
    fs.close(fd, function (err1) {
      fs.unlink(tmpPath, function (err2) {
        cb(err2 || err1 || err)
      })
    })
  }
  fs.open(tmpPath, 'w+', function (err, fd) {
    if (err) return cb(err)
    self.git.extractSignature(obj, function (err, parts) {
      if (err) return closeEnd(err)
      writeAll(fd, parts.signature, function (err) {
        if (err) return closeEnd(err)
        try { next(fd, parts) }
        catch(e) { closeEnd(e) }
      })
    })
  })
  function next(fd, parts) {
    var readSig = fs.createReadStream(null, {fd: fd, start: 0})
    var done = multicb({pluck: 1, spread: true})
    var gpg = proc.spawn('gpg', ['--status-fd=1', '--keyid-format=long',
      '--verify', '/dev/fd/3', '-'], {
      stdio: ['pipe', 'pipe', 'pipe', readSig]
    }).on('close', done().bind(null, null))
    .on('error', console.error.bind(console, 'gpg'))
    gpg.stdin.end(parts.payload)
    pull(toPull.source(gpg.stdout), u.pullConcat(done()))
    pull(toPull.source(gpg.stderr), u.pullConcat(done()))
    done(function (err, code, status, output) {
      if (err) return closeEnd(err)
      fs.unlink(tmpPath, function (err) {
        if (err) return cb(err)
        cb(null, {
          goodsig: status.includes('\n[GNUPG:] GOODSIG '),
          status: status.toString(),
          output: output.toString()
        })
      })
    })
  }
}

App.prototype.getScript = function (filepath, cb) {
  var filename = path.join(this.scriptDir, filepath)
  var self = this
  fs.stat(filename, function (err, stat) {
    if (err) return cb(err)
    var resolved = require.resolve(filename)
    var prevMtime = self.mtimes[resolved]
    var mtime = stat.mtime.getTime()
    if (mtime !== prevMtime) {
      delete require.cache[resolved]
      self.mtimes[filename] = mtime
    }
    var module
    try { module = require(resolved) }
    catch(e) { return cb(e) }
    cb(null, module)
  })
}

function writeNewFile(dir, data, tries, cb) {
  var id = Base64URL.encode(crypto.randomBytes(8))
  fs.writeFile(path.join(dir, id), data, {flag: 'wx'}, function (err) {
    if (err && err.code === 'EEXIST' && tries > 0) return writeNewFile(dir, data, tries-1, cb)
    if (err) return cb(err)
    cb(null, id)
  })
}

App.prototype.saveDraft = function (id, url, form, content, cb) {
  var self = this
  if (!self.madeDraftsDir) {
    mkdirp.sync(self.draftsDir)
    self.madeDraftsDir = true
  }
  if (/[\/:\\]/.test(id)) return cb(new Error('draft id cannot contain path seperators'))
  var draft = {
    url: url,
    form: form,
    content: content
  }
  var data = JSON.stringify(draft)
  if (id) fs.writeFile(path.join(self.draftsDir, id), data, cb)
  else writeNewFile(self.draftsDir, data, 32, cb)
}

App.prototype.getDraft = function (id, cb) {
  var self = this
  fs.readFile(path.join(self.draftsDir, id), 'utf8', function (err, data) {
    if (err) return cb(err)
    var draft
    try { draft = JSON.parse(data) }
    catch(e) { return cb(e) }
    draft.id = id
    cb(null, draft)
  })
}

App.prototype.discardDraft = function (id, cb) {
  fs.unlink(path.join(this.draftsDir, id), cb)
}

App.prototype.listDrafts = function () {
  var self = this
  return u.readNext(function (cb) {
    fs.readdir(self.draftsDir, function (err, files) {
      if (err && err.code === 'ENOENT') return cb(null, pull.empty())
      if (err) return cb(err)
      cb(null, pull(
        pull.values(files),
        pull.asyncMap(function (name, cb) {
          self.getDraft(name, cb)
        })
      ))
    })
  })
}
