import smtplib
from email.mime.text import MIMEText
import logging

logger = logging.getLogger("Emailer")

def send_email(config, subject, message):
    try:
        msg = MIMEText(message)
        msg['Subject'] = subject
        msg['From'] = config.get('from', 'autoscaler@example.com')
        msg['To'] = ", ".join(config.get('to', []))

        with smtplib.SMTP(config['host'], config['port']) as server:
            if config.get('starttls', True):
                server.starttls()
            if config.get('user') and config.get('password'):
                server.login(config['user'], config['password'])
            server.sendmail(msg['From'], config['to'], msg.as_string())
        logger.info(f"Email sent to {config.get('to')}")
    except Exception as e:
        logger.error(f"Error sending email: {e}")
