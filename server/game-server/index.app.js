
exports.startServer = function(server, cb) {

    const compression = require('compression');
    const morgan = require('morgan');
    const validator = require('validator');
    const config = require('./configs/server.json');

    const zlib = require('zlib');
    const protocol = require('./app/common/protocol');
    const helmet = require('helmet')
    const limit = require('express-rate-limit')

    const tokenHelper = require('./app/common/token')
    const redisHelper = require('./app/common/redisHelper');
    const guideController = require ('./app/scripts/controllers/guideController');
    const fixTask = require('./app/scripts/controllers/fixTaskController')
    const fixAchievement = require('./app/scripts/controllers/fixAchievementController')
    const GameRedisHelper = new redisHelper(config.gameRedis);
    exports.GameRedisHelper = GameRedisHelper;
    const fs = require('fs')
    let FIXDB = {}

    // 加载配置表进内存
    let files = fs.readdirSync('./app/datas/')
    files.map(element =>{
        if (!element.startsWith('.')) {
            let perfix = element.split('.')[0]
            let data = require('./app/datas/'+element)
            let fileName =  perfix.split('_')[1]
            let funcName = fileName+ "Data"
            let indexs = fileName + 'Indexes'
            if(data[indexs]){
                let key = perfix + '_indexes'
                FIXDB[key.toUpperCase()] = data[indexs]
            }
            let loadData = data[funcName]()
            FIXDB[perfix.toUpperCase()] = loadData
        }
    })
    global.FIXDB = FIXDB
    //配置表加载完成...
    let FIX_TASK = new fixTask();
    global.FIX_TASK = FIX_TASK.loadFixData();
    
    let FIX_ACHIEVEMENT= new fixAchievement();
    global.FIX_ACHIEVEMENT = FIX_ACHIEVEMENT.initAchievement()
    // 初始化
    global.FIX_INIT_TASKDATA = FIX_TASK.initTask()

    let app = server.app;
    app.set('host', config.host);
    app.set('port', config.port);
    let conn = require('./app/log/KafkaProducer')
    const constant = require('./app/log/constants/index')
    const logUtil = require('./app/log/logUtils')(conn)
    const logParams = require('./app/log/midderware/index')
    app.use(logParams(logUtil,constant,GameRedisHelper))
    let tokenUtil = new tokenHelper(GameRedisHelper)
    app.use(helmet())
    app.use(limit({
        windowMs:15*60*1000,  // 15分钟
        max:1000,               // limit each IP to 1000 requests per windowMs
        statusCode:500,
        message:'too many connection'
    }))


    const tokenEnabled = true;

    function checkToken(url, uuid, token, callback, enabled)
    {
        if (enabled) {
            if (token && url != '/fetchservertime') {
                if(tokenUtil.verifyToken(token)){
                    // token 校验成功 刷新 token
                    tokenUtil.freashToken(uuid,token)
                    tokenUtil.existToken(uuid).then(element =>{
                        if(element === 1){
                            callback(true)
                        }else{
                            callback(1)
                        }
                    }).catch(e=>{
                        callback(false)
                    })
                }else{
                    callback(false)
                }
            } else {
                callback(true);
            }
        } else {
            callback(true);
        }
    }

    app.use(function (req, res, next) {
        if (req.method == 'POST') {
            req.setEncoding('utf8');
            let data = "";
            req.on('data', function (chunk) {
                data += chunk;
            });

            req.on('end', function () {
                if (config.encrypt) {
                    var compressed = Buffer.from(data, 'base64');
                    zlib.inflate(compressed, (err, buffer) => {
                        if (err) {
                            console.error(err);
                        } else {
                            try {
                                req.body = JSON.parse(buffer.toString());
                                if (config.debug) console.debug("\nrequest:", buffer.toString());
                                checkToken(req.url, req.body.uuid, req.body.token, tokenValid => {
                                    if(tokenValid === 1){
                                        return protocol.responseSend(res, { code: 999 });
                                    }
                                    if (tokenValid && tokenValid !== 1 ) {
                                        next();
                                    } else {
                                        protocol.responseSend(res, { code: 999 });
                                        //res.json({ code: 999 });
                                    }
                                }, tokenEnabled);
                            } catch (e) {
                                console.error('Encrypt illegal json format: '+e);
                            }
                        }
                    });
                } else {
                    if (config.debug) console.debug("\nrequest:", data);
                    try {
                        req.body = JSON.parse(data);
                        checkToken(req.url, req.body.uuid, req.body.token, tokenValid => {
                            if(tokenValid === 1){
                                return protocol.responseSend(res, { code: 400 });
                            }
                            if (tokenValid && tokenValid !== 1) {
                                next();
                            } else {
                                res.json({ code: 999 });
                            }
                        }, tokenEnabled);
                    } catch (e) {
                        console.error('Illegal json format: '+e);
                    }
                }
            });
        } else {
            next();
        }
    });

app.use(function (req, res, next) {
    if (!!req.body.guideinfo) {
        console.log("save user guide info", req.body.guideinfo)
        let guide = new guideController (req.body.uuid, req.multiController, req.taskController);
        guide.saveUseGuideData (req.body.guideinfo);
        next ()
    }else {
        next ()
    }
});
    app.use(compression());

// exports.GameDB = GameDB;
//exports.FixedDB = FixedDB;

// slog
    if (config.debug)
        app.use(morgan('short'));

//mapping();
    const domain = require('domain')
    app.use((req,res,next) =>{
        const req_domain = domain.create()
        req_domain.on('error',err =>{
            console.log('-----------',err)
            res.status(500).send(err.stack)
        })
        req_domain.run(next)
    })

    server.loadResponseTime();

    const RouteMapping = require('./app/mapping');
    RouteMapping(app);
    cb(null);
}

