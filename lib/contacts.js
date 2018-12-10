var pull = require('pull-stream')
var defer = require('pull-defer')
var many = require('pull-many')

module.exports = Contacts

function Contacts(sbot) {
  if (!(this instanceof Contacts)) return new Contacts(sbot)
  this.sbot = sbot
}

Contacts.prototype._createContactStream = function (source, dest) {
  if (!this.sbot.links) return pull.error(new Error('missing sbot.links'))
  return pull(
    this.sbot.links({
      source: source,
      dest: dest,
      rel: 'contact',
      values: true,
      reverse: true
    }),
    pull.filter(function (msg) {
      var c = msg && msg.value && msg.value.content
      return c && c.type === 'contact' && (!dest || c.contact === dest)
    }),
    pull.map(function (msg) {
      var c = msg && msg.value && msg.value.content
      return {
        source: msg.value.author,
        dest: c.contact,
        msg: msg,
        value: c.following ? true : c.flagged || c.blocking ? false : null
      }
    }),
    pull.unique(function (edge) {
      return edge.source + '-' + edge.dest
    })
  )
}

Contacts.prototype.createFollowsStream = function (id) {
  return pull(
    this._createContactStream(id, null),
    pull.filter('value'),
    pull.map('dest')
  )
}

Contacts.prototype.createFollowersStream = function (id) {
  return pull(
    this._createContactStream(null, id),
    pull.filter('value'),
    pull.map('source')
  )
}

Contacts.prototype.createFollowedFollowersStream = function (source, dest) {
  var follows = {}, followers = {}
  return pull(
    many([
      this._createContactStream(source, null),
      this._createContactStream(null, dest)
    ]),
    pull.filter('value'),
    pull.map(function (edge) {
      if (edge.source === source) {
        if (followers[edge.dest]) {
          delete followers[edge.dest]
          return edge.dest
        } else {
          follows[edge.dest] = true
        }
      } else if (edge.dest === dest) {
        if (follows[edge.source]) {
          delete follows[edge.source]
          return edge.source
        } else {
          followers[edge.source] = true
        }
      }
    }),
    pull.filter()
  )
}

Contacts.prototype.createFriendsStream = function (opts, endCb) {
  if (typeof opts === 'string') opts = {id: opts}
  var id = opts.id
  var msgIds = opts.msgIds
  var follows = {}, followers = {}
  var blocks = {}, blockers = {}
  var enemies = opts.enemies && {}
  return pull(
    many([
      this._createContactStream(id, null),
      this._createContactStream(null, id)
    ]),
    pull.map(function (edge) {
      if (edge.value) {
        if (edge.source === id) {
          if (followers[edge.dest]) {
            var item2 = followers[edge.dest]
            delete followers[edge.dest]
            return msgIds ? {feed: edge.dest, msg: edge.msg, msg2: item2.msg} : edge.dest
          } else {
            follows[edge.dest] = msgIds ? {feed: edge.dest, msg: edge.msg} : edge.dest
          }
        } else if (edge.dest === id) {
          if (follows[edge.source]) {
            var item2 = follows[edge.source]
            delete follows[edge.source]
            return msgIds ? {feed: edge.source, msg: edge.msg, msg2: item2.msg} : edge.source
          } else {
            followers[edge.source] = msgIds ? {feed: edge.source, msg: edge.msg} : edge.source
          }
        }
      } else if (edge.value === false) {
        if (edge.source === id) {
          if (enemies && blockers[edge.dest]) {
            var item2 = blockers[edge.dest]
            delete blockers[edge.dest]
            enemies[edge.dest] = msgIds ? {feed: edge.dest, msg: edge.msg, msg2: item2.msg} : edge.dest
          } else {
            blocks[edge.dest] = msgIds ? {feed: edge.dest, msg: edge.msg} : edge.dest
          }
        } else if (edge.dest === id) {
          if (enemies && blocks[edge.source]) {
            var item2 = blocks[edge.source]
            delete blocks[edge.source]
            enemies[edge.source] = msgIds ? {feed: edge.source, msg: edge.msg, msg2: item2.msg} : edge.source
          } else {
            blockers[edge.source] = msgIds ? {feed: edge.source, msg: edge.msg} : edge.source
          }
        }
      }
    }),
    pull.filter(),
    endCb && function (read) {
      return function (abort, cb) {
        read(abort, function (end, data) {
          cb(end, data)
          if (end) endCb(end === true ? null : end, {
            followers: Object.values(followers),
            follows: Object.values(follows),
            blocks: Object.values(blocks),
            blockers: Object.values(blockers),
            enemies: Object.values(enemies),
          })
        })
      }
    }
  )
}

Contacts.prototype.createContactStreams = function (opts) {
  var msgIds = opts.msgIds
  var follows = defer.source()
  var followers = defer.source()
  var blocks = defer.source()
  var blockers = defer.source()
  var enemies = defer.source()
  var friends = this.createFriendsStream(opts, function (err, more) {
    follows.resolve(err ? pull.error(err) : pull.values(more.follows))
    followers.resolve(err ? pull.error(err) : pull.values(more.followers))
    blocks.resolve(err ? pull.error(err) : pull.values(more.blocks))
    blockers.resolve(err ? pull.error(err) : pull.values(more.blockers))
    enemies.resolve(err ? pull.error(err) : pull.values(more.enemies))
  })
  return {
    friends: friends,
    follows: follows,
    followers: followers,
    enemies: enemies,
    blocks: blocks,
    blockers: blockers,
  }
}
