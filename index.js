const pm2 = require('pm2')
const hostname = require('os').hostname()
const nodemailer = require('nodemailer')
const markdown = require('nodemailer-markdown').markdown
const config = require('yamljs').load(__dirname + '/config.yml')
const _ = require('lodash.template')
const template = require('fs').readFileSync('./templates/client/template.md')
const templateTech = require('fs').readFileSync('./templates/tech/template.md')
const async = require('async')
const pug = require("pug");
const util = require('util')
const p = require('path')
const path = require("path");

const transporter = nodemailer.createTransport(require('nodemailer-smtp-transport')(config.smtp))

transporter.use('compile', markdown({useEmbeddedImages: true}))

const queue = []
let timeout = null
let lastEventTime = null

/**
 * Compile template
 * @param string template
 * @param object data
 */
function compile(template, data) {
    const s = _(template)
    return s(data)
}


function sendMailData(values) {
  const htmlReady = pug.renderFile(path.join(`${__dirname}/templates/mail_template.pug`),
      {
        content: values.markdown,
        title: values.subject
      });

  transporter.sendMail(
      {
        ...values,
        html: htmlReady
      }, function(err, info) {
    if(err) {
      console.error(err)
    }

    console.log('Mail sent', info)
  })
}

/**
 * Send an email through smtp transport
 * @param object opts
 */
function sendMail(opts) {

  if(!opts.subject || !opts.text) {
    throw new ReferenceError("No text or subject to be mailed")
  }

  const mailData = {
    from: opts.from || config.mail.from,
    subject: opts.subject,
    markdown: opts.text,
    attachments: []
  }

  if (config.mail.client)
  {
    mailData.to = config.mail.client;
    sendMailData(mailData);
  }

  if (config.mail.tech)
  {
    mailData.to = config.mail.tech;
    mailData.attachments = opts.attachments;
    sendMailData(mailData);
  }
}

/**
 * Process the events queue
 * if there is only one event, send an email with it
 * if there are more than one, join texts and attachments
 */
function processQueue() {
  const l = queue.length

  if(l == 0) {
    return;
  }

  //just one?
  if(l === 1) {
    return sendMail(queue[0])
  }

  //Concat texts, get the multiple subject
  let text = ''
  const attachments = []

  const subject = compile(config.multiple_subject, queue[0])

  for(const i in queue) {
    text += queue[i].text

    if(config.attach_logs) {

      //don't attach twice the same file
      for(const j in queue[i].attachments) {
        let has = false

        for(const a in attachments) {
          if(attachments[a].path == queue[i].attachments[j].path) {
            has = true
            break;
          }
        }

        if(has === false) {
          attachments.push(queue[i].attachments[j])
        }
      }
    }
  }
  sendMail({
    subject: subject,
    text: text,
    attachments: attachments
  })
    
  //reset queue
  queue.length = 0

  // Reset send mail delay
  lastEventTime = null
}

pm2.launchBus(function(err, bus) {

  if(err) {
    throw err
  }

  bus.on('process:event', function(e) {

    if(e.manually === true) {
      return;
    }

    //it's an event we should watch
    if(~config.events.indexOf(e.event)) {

      e.date = new Date(e.at).toString()

      e = util._extend(e, {
        hostname: hostname,
        text: compile(template, e),
        subject: compile(config.subject, e)
      })

      //should we add logs?
      if(config.attach_logs) {
        e.attachments = []
        ;['pm_out_log_path', 'pm_err_log_path']
        .forEach(function(log) {
          e.attachments.push({
            filename: p.basename(e.process[log]),
            path: e.process[log]
          })
        })
      }

      queue.push(e)

      if(timeout) {
        clearTimeout(timeout)

        if (lastEventTime && Date.now() - lastEventTime >= config.max_polling_time) {
          processQueue()
        }
      }

      timeout = setTimeout(processQueue, config.polling)
      if (!lastEventTime) {
        lastEventTime = Date.now()
      }
    }
  })

  bus.on('pm2:kill', function() {
    console.error('PM2 is beeing killed')
  })
})
