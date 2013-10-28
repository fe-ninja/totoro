'use strict';

var inherits = require('util').inherits
var express = require('express')
var path = require('path')
var fs = require('fs')
var http = require('http')
var eio = require('engine.io-client')
var common = require('totoro-common')
var colorful = require('colorful')

var logger = require('./logger')
var handleCfg = require('./handle-cfg')
var report = require('./report')
var getRepo = require('./get-repo')


module.exports = Client


function Client(cfg) {
    var that = this
    this.cfg = handleCfg(cfg)
    this.report = cfg.report || report

    if (cfg.clientRoot) {
        this.launchServer(function() {
            that.launchTest()
        })
    } else {
        this.launchTest()
    }
}

Client.prototype.launchServer = function(callback) {
    var that = this
    var cfg = this.cfg
    var clientRoot = cfg.clientRoot

    process.chdir(clientRoot)

    var app = express()
    app.use(express.static(clientRoot))

    app.listen(cfg.clientPort, cfg.clientHost, function() {
        logger.debug('Start client server <' + cfg.clientHost + ':' + cfg.clientPort + '>')
        callback()

    }).on('error', function(e) {
        if (e.code === 'EADDRINUSE') {
            logger.debug('Port %d is in use, will auto find another one.', cfg.clientPort)
            cfg.clientPort = randomPort()
            that.launchServer(callback)
        } else {
            throw e
        }
    })
}

Client.prototype.sendMessage = function(key, msg) {
    var packet = [key, msg]
    this.socket.send(JSON.stringify(packet))
}

Client.prototype.launchTest = function() {
    var that = this
    var cfg = this.cfg
    var socket = this.socket = eio(
            'ws://' + cfg.serverHost + ':' + cfg.serverPort)

    socket.onopen = function() {
        var pkgFile = path.join(__dirname, '..', 'package.json')
        var version = JSON.parse(fs.readFileSync(pkgFile)).version

        getRepo(cfg.runner, function(repo) {
            logger.debug('Found repo <' + repo + '>')

            function generateInitData(cfg) {
                var i, rt = {}, black = ['serverHost', 'serverPort', 'clientRoot']

                for (i in cfg) {
                    if (black.indexOf(i) > -1) continue
                    rt[i] = cfg[i]
                }

                rt.repo = repo
                rt.version = version
                return rt
            }

            that.sendMessage('order/init', generateInitData(cfg))
        })
    }


    var handlers = {
        'order/report': function(reports) {
            var labors = that.labors

            reports.forEach(function(report) {
                var action = report.action
                var info = report.info

                switch (action) {
                    case 'debug':
                    case 'info':
                    case 'warn':
                    case 'error':
                        logger[action].apply(logger, info)
                        break
                    case 'pass':
                        print('.', 'green')
                        break
                    case 'pending':
                        print('.', 'cyan')
                        break
                    case 'fail':
                        print('×', 'red')
                        break
                    case 'timeout':
                        logger.warn('Timeout!')
                    case 'endAll':
                        var rt = that.report(info, cfg.verbose)
                        that.destroy(rt ? 0 : 1)
                        break
                    default:
                        logger.warn('Not realized report action <' + action + '>')
                        break
                }
            })
        },
        'order/proxyReq': function(info) {
            var that = this
            var opts = {
                hostname: cfg.clientHost,
                port: cfg.clientPort,
                path: info.path,
                headers: info.headers
            }

            http.request(opts, function(res) {
                var buffer = new Buffer(parseInt(res.headers['content-length'], 10))
                var offset = 0

                res.on('data', function(data) {
                    data.copy(buffer, offset)
                    offset += data.length
                })

                res.on('end', function() {
                    that.sendMessage('order/proxyRes', {
                        path: info.path,
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: buffer
                    })
                })

            }).on('error', function(err) {
                logger.warn('Proxy error <' + err + '>')
                that.sendMessage('order/proxyRes', {
                    path: info.path,
                    statusCode: 500,
                    body: err
                })
            }).end()
        }
    }

    socket.onmessage = function(message) {
        message = JSON.parse(message)
        var key = message[0]
        var handler = handlers[key]
        handler && handler.call(that, message[1])
    }

    socket.onerror = function() {
        logger.error('Server is not available, please check your config or try again later.')
    }

    socket.onclose = function() {
        logger.error('Server is interrupted, please try again later.')
    }
}

Client.prototype.destroy = function(code) {
    logger.debug('Client destroy.')
    code = code || 0
    process.exit(code)
}


Client.config = require('./config')
Client.list = require('./list')


function print(str, c) {
    str = str || ''
    str = c ? colorful[c](str) : str
    process.stdout.write(str)
}


function randomPort() {
    return Math.floor(Math.random() * 1000) + 7000
}
