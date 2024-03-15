const {createConnection}=require('net');
const {connect,createSecureContext}=require('tls');
const {resolveMx}=require('dns');
const {DKIMSign}=require('dkim-signer');
const CRLF='\r\n';

function dummy() {}
module.exports=function(options) {
	options=options||{};
	const logger=options.logger||(options.silent&&{
		debug: dummy,
		info: dummy,
		warn: dummy,
		error: dummy
	}||{
		debug: console.log,
		info: console.info,
		warn: console.warn,
		error: console.error
	});
	const dkimPrivateKey=(options.dkim||{}).privateKey;
	const dkimKeySelector=(options.dkim||{}).keySelector||'dkim';
	const devPort=options.devPort||-1;
	const devHost=options.devHost||'localhost';
	const smtpPort=options.smtpPort||25;
	const smtpHost=options.smtpHost||-1;
	const rejectUnauthorized=options.rejectUnauthorized;
	const autoEHLO=options.autoEHLO;
	if(typeof (options.tls)=="undefined") options.tls=true;


	function getHost(email) {
		const m=/[^@]+@([\w\d\-\.]+)/.exec(email);
		return m&&m[1];
	}

	function groupRecipients(recipients) {
		let groups={};
		let host;
		const recipients_length=recipients.length;
		for(let i=0;i<recipients_length;i++) {
			host=getHost(recipients[i]);
			(groups[host]||(groups[host]=[])).push(recipients[i])
		}
		return groups;
	}

	/**
	 * connect to domain by Mx record
	 */
	function connectMx(domain,callback) {
		if(devPort===-1) { // not in development mode -> search the MX
			resolveMx(domain,function(err,data) {
				function tryConnect(i) {
					if(i>=data.length) return callback(new Error('can not connect to any SMTP server'));

					const sock=createConnection(smtpPort,data[i].exchange);

					sock.on('error',function(err) {
						logger.error('Error on connectMx for: ',data[i],err);
						tryConnect(++i)
					});

					sock.on('connect',function() {
						logger.debug('MX connection created: ',data[i].exchange);
						sock.removeAllListeners('error');
						callback(null,sock);
					})
				}
				// if(domain=="localhost"){
				// 	data=["127.0.0.1"];
				// 	tryConnect(0);
				// 	return;
				// }

				if(err) {
					return callback(err);
				}

				data.sort(function(a,b) {return a.priority>b.priority});
				logger.debug('mx resolved: ',data);

				if(!data||data.length===0) {
					return callback(new Error('can not resolve Mx of <'+domain+'>'));
				}
				if(smtpHost!==-1) data.push({exchange: smtpHost});


				tryConnect(0)
			})
		} else { // development mode -> connect to the specified devPort on devHost
			const sock=createConnection(devPort,devHost);

			sock.on('error',function(err) {
				callback(new Error('Error on connectMx (development) for "'+devHost+':'+devPort+'": '+err))
			});

			sock.on('connect',function() {
				logger.debug('MX (development) connection created: '+devHost+':'+devPort);
				sock.removeAllListeners('error');
				callback(null,sock);
			})
		}
	}

	function sendToSMTP(domain,srcHost,from,recipients,body,cb) {
		const callback=(typeof cb==='function')? cb:function() {};
		connectMx(domain,function(err,sock) {
			if(err) {
				logger.error('error on connectMx',err.stack);
				return callback(err);
			}

			function w(s) {
				logger.debug('send '+domain+'>'+s);
				sock.write(s+CRLF);
			}

			sock.setEncoding('utf8');

			sock.on('data',function(chunk) {
				data+=chunk;
				parts=data.split(CRLF);
				const parts_length=parts.length-1;
				for(let i=0,len=parts_length;i<len;i++) {
					onLine(parts[i]);
				}
				data=parts[parts.length-1];
			});

			sock.on('error',function(err) {
				logger.error('fail to connect '+domain);
				callback(err);
			});

			let data='';
			let step=0;
			let loginStep=0;
			const queue=[];
			const login=[];
			let parts;
			let cmd;
			let upgraded=false;

			/*
			 if(mail.user && mail.pass){
			   queue.push('AUTH LOGIN');
			   login.push(new Buffer(mail.user).toString("base64"));
			   login.push(new Buffer(mail.pass).toString("base64"));
			 }
			 */

			queue.push('MAIL FROM:<'+from+'>');
			const recipients_length=recipients.length;
			for(let i=0;i<recipients_length;i++) {
				queue.push('RCPT TO:<'+recipients[i]+'>');
			}
			queue.push('DATA');
			queue.push('QUIT');
			queue.push('');

			function response(code,msg) {
				switch(code) {
					case 220:
						//*   220   on server ready
						//*   220   服务就绪
						if(upgraded==="in-progress"&&options.tls==true) {
							sock.removeAllListeners('data');

							let original=sock;
							original.pause();

							let opts={
								socket: sock,
								host: sock._host,
								rejectUnauthorized,
							};
							if(options.tls==true) {
								opts.secureContext=createSecureContext({cert: options.tls.cert,key: options.tls.key});
							}

							sock=connect(
								opts,
								() => {
									sock.on('data',function(chunk) {
										data+=chunk;
										parts=data.split(CRLF);
										const parts_length=parts.length-1;
										for(let i=0,len=parts_length;i<len;i++) {
											onLine(parts[i])
										}
										data=parts[parts.length-1]
									});

									sock.removeAllListeners('close');
									sock.removeAllListeners('end');

									return;
								}
							);

							sock.on('error',function(err) {
								logger.error('Error on connectMx for: ',err);
							});

							original.resume();
							upgraded=true;
							w("EHLO "+srcHost);
							break;
						} else {
							if(/\besmtp\b/i.test(msg)||autoEHLO) {
								// TODO:  determin AUTH type; auth login, auth crm-md5, auth plain
								cmd='EHLO';
							} else {
								upgraded=true;
								cmd='HELO';
							}
							w(cmd+' '+srcHost);
							break;
						}

					case 221: // bye
						sock.end();
						callback(null,msg);
						break;
					case 235: // verify ok
					case 250: // operation OK
						if(options.tls===true) {
							if(upgraded!=true) {
								if(/\bSTARTTLS\b/i.test(msg)) {
									w('STARTTLS');
									upgraded="in-progress";
								} else {
									upgraded=true;
								}

								break;
							}
						}

					case 251: // foward
						if(step===queue.length-1) {
							logger.info('OK:',code,msg);
							callback(null,msg);
						}
						w(queue[step]);
						step++;
						break;

					case 354: // start input end with . (dot)
						console.log()
						logger.info('sending mail',body);
						w(body);
						w('');
						w('.');
						break;

					case 334: // input login
						w(login[loginStep]);
						loginStep++;
						break;

					default:
						if(code>=400) {
							logger.warn('SMTP responds error code',code);
							callback(new Error('SMTP code:'+code+' msg:'+msg));
							sock.end();
						}
				}
			}

			let msg='';

			function onLine(line) {
				logger.debug('recv '+domain+'>'+line);

				msg+=(line+CRLF);
				if(line[3]===' ') {
					// 250-information dash is not complete.
					// 250 OK. space is complete.
					let lineNumber=parseInt(line.substr(0,3));
					response(lineNumber,msg);
					msg='';
				}
			}
		})
	}

	function getAddress(address) {
		return address.replace(/^.+</,'').replace(/>\s*$/,'').trim();
	}

	function getAddresses(addresses) {
		const results=[];
		if(!Array.isArray(addresses)) {
			addresses=addresses.split(',');
		}

		const addresses_length=addresses.length;
		for(let i=0;i<addresses_length;i++) {
			results.push(getAddress(addresses[i]));
		}
		return results;
	}

	/**
	 * sendmail directly
	 *
	 * @param mail {object}
	 *             from
	 *             to
	 *             cc
	 *             bcc
	 *             replyTo
	 *             returnTo
	 *             subject
	 *             type         default 'text/plain', 'text/html'
	 *             charset      default 'utf-8'
	 *             encoding     default 'base64'
	 *             id           default timestamp+from
	 *             headers      object
	 *             content
	 *             attachments
	 *               [{
	 *                 type
	 *                 filename
	 *                 content
	 *               }].
	 *
	 * @param callback function(err, domain).
	 *
	 */
	function sendmail(mail) {
		return new Promise(function(resolve,reject) {
			const mailcomposer=require('mailcomposer');
			const mailMe=mailcomposer(mail);
			let recipients=[];
			let groups;
			let srcHost;
			if(mail.to) {
				recipients=recipients.concat(getAddresses(mail.to));
			}

			if(mail.cc) {
				recipients=recipients.concat(getAddresses(mail.cc));
			}

			if(mail.bcc) {
				recipients=recipients.concat(getAddresses(mail.bcc));
			}

			groups=groupRecipients(recipients);

			const from=getAddress(mail.from);
			srcHost=getHost(from);

			mailMe.build(function(err,message) {
				if(err) {
					logger.error('Error on creating message : ',err);
					reject(err);
					return
				}
				if(dkimPrivateKey) {
					const signature=DKIMSign(message,{
						privateKey: dkimPrivateKey,
						keySelector: dkimKeySelector,
						domainName: srcHost
					});
					message=signature+'\r\n'+message;
				}
				for(let domain in groups) {
					sendToSMTP(domain,srcHost,from,groups[domain],message,function(err, reply){
						if(err){
							reject(err);
						}else{
							resolve(reply);
						}
					});
				}
			});
		})
	}
};
