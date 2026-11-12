#!/usr/bin/env python3
"""Run from the repo root. Python 3.10+, AWS CLI v2, Node 22+, Docker Desktop (Linux containers).
Never reads the local emulator .env; credentials use your AWS CLI profile/session.
"""
import argparse, getpass, hashlib, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path
from template import make_template
ROOT=Path(__file__).resolve().parents[2]
BUILD=ROOT/'deploy/aws/.build'; STATE=ROOT/'deploy/aws/.state'

def run(args, *, capture=False, env=None, input=None):
    command=[str(a) for a in args]
    if os.name=='nt' and command[0]=='npm': command[0]='npm.cmd'
    result=subprocess.run(command,cwd=ROOT,env=env or os.environ,text=True,input=input,
        stdout=subprocess.PIPE if capture else None,stderr=subprocess.PIPE if capture else None)
    if result.returncode: raise RuntimeError((result.stderr or result.stdout or f'{command[0]} failed with exit {result.returncode}').strip())
    return result.stdout or ''

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('phase',choices=['check','deploy','google','mail','sms','web','model','staff','outputs'])
    p.add_argument('--region',default='eu-west-1');p.add_argument('--stack',default='connected-demo')
    p.add_argument('--email');p.add_argument('--first');p.add_argument('--last')
    p.add_argument('--sender',help='mail phase: the address ConnectED emails come from, e.g. no-reply@yourdomain.org')
    p.add_argument('--model',default='ml/models/logreg-v1');p.add_argument('--reuse-image',action='store_true')
    a=p.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,29}',a.stack): p.error('stack must be 2-30 lower-case letters, digits or hyphens, beginning with a letter')
    BUILD.mkdir(exist_ok=True);STATE.mkdir(exist_ok=True)
    env=os.environ.copy();env['AWS_DEFAULT_REGION']=a.region;env['AWS_REGION']=a.region;env['AWS_PAGER']=''
    def aws(*args,capture=True):
        return run(['aws',*args,'--region',a.region,'--no-cli-pager'],capture=capture,env=env)
    def obj(*args): return json.loads(aws(*args,'--output','json'))
    identity=obj('sts','get-caller-identity');account=identity['Account']
    print(f'AWS account: {account}; region: {a.region}; stack: {a.stack}',flush=True)
    sf=STATE/f'{account}-{a.region}-{a.stack}.json'
    state=json.loads(sf.read_text()) if sf.exists() else {}
    def save(): sf.write_text(json.dumps(state,indent=2))
    def outputs():
        o=obj('cloudformation','describe-stacks','--stack-name',a.stack)['Stacks'][0]['Outputs']
        result={x['OutputKey']:x['OutputValue'] for x in o};state['outputs']=result;save();return result
    def appenv(o):
        values={'AWS_REGION':a.region,'GRADEBOOK_TABLE_NAME':o['TableName'],'MODEL_BUCKET':o['ModelBucket'],
            'COGNITO_USER_POOL_ID':o['SchoolPoolId'],'COGNITO_CLIENT_ID':o['SchoolClientId'],
            'PLATFORM_COGNITO_USER_POOL_ID':o['AngazaPoolId'],'PLATFORM_COGNITO_CLIENT_ID':o['AngazaClientId'],
            'RISK_SCORER_FUNCTION':o['ScorerFunction'],'RISK_PREDICTION_FUNCTION':o['PredictionFunction'],
            'VITE_AWS_REGION':a.region,'VITE_GRAPHQL_ENDPOINT':o['GraphqlUrl'],
            'VITE_COGNITO_CLIENT_ID':o['SchoolClientId'],'VITE_COGNITO_USER_POOL_ID':o['SchoolPoolId'],'VITE_COGNITO_DOMAIN':o['SchoolDomain'],
            'VITE_PLATFORM_COGNITO_CLIENT_ID':o['AngazaClientId'],'VITE_PLATFORM_COGNITO_USER_POOL_ID':o['AngazaPoolId'],'VITE_PLATFORM_COGNITO_DOMAIN':o['AngazaDomain'],
            # The staff command emails its invitation the same way the deployed app does.
            'MAIL_FROM':state.get('mail_from',''),'SITE_URL':o['SiteUrl']}
        for k in ['DDB_ENDPOINT','S3_ENDPOINT','EVENTS_ENDPOINT','SFN_ENDPOINT','COGNITO_ENDPOINT','LAMBDA_ENDPOINT','VITE_COGNITO_ENDPOINT']: values[k]=''
        path=ROOT/'.env.aws.local';path.write_text('\n'.join(f'{k}={v}' for k,v in values.items())+'\n')
        return {**env,**values,'DOTENV_CONFIG_PATH':str(path)}
    def web(o):
        run(['npm','run','build','--workspace','@connected/web','--','--mode','aws'],env=appenv(o))
        dist=ROOT/'frontend/react-app/dist'
        # Files with fixed names must always be fetched fresh, or devices keep an old app; hashed files never change.
        fresh=['index.html','sw.js','registerSW.js']
        aws('s3','sync',str(dist),f"s3://{o['WebBucket']}/",*[x for f in fresh for x in ('--exclude',f)],'--cache-control','public,max-age=31536000,immutable',capture=False)
        aws('s3','cp',str(dist/'index.html'),f"s3://{o['WebBucket']}/index.html",'--cache-control','no-cache,no-store,must-revalidate','--content-type','text/html',capture=False)
        for f in ['sw.js','registerSW.js']:
            if (dist/f).exists():
                aws('s3','cp',str(dist/f),f"s3://{o['WebBucket']}/{f}",'--cache-control','no-cache,no-store,must-revalidate','--content-type','application/javascript',capture=False)
        aws('cloudfront','create-invalidation','--distribution-id',o['DistributionId'],'--paths','/*',capture=False)
    if a.phase=='check':
        for command in [['aws','--version'],['node','--version'],['npm','--version'],['docker','version']]: run(command,env=env)
        version=run(['node','--version'],capture=True).strip()
        if int(version.lstrip('v').split('.')[0])<22: raise RuntimeError('Install Node 22 LTS or newer.')
        if not (ROOT/a.model/'manifest.json').exists(): raise RuntimeError('Missing model manifest: '+a.model)
        print('Local prerequisites and AWS identity OK. Check Billing > Free Tier/credits and create a cost budget before deploy.');return
    if a.phase=='deploy':
        run(['docker','info'],capture=True,env=env)
        run(['npm','ci','--no-audit','--no-fund'],env=env)
        run(['node','deploy/aws/bundle.mjs'],env=env)
        zip_path=BUILD/'backend.zip'
        with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED) as z:
            for name in ['api','prediction','report','link','authmail']: z.write(BUILD/(name+'.mjs'),name+'.mjs')
        code_key='backend/'+hashlib.sha256(zip_path.read_bytes()).hexdigest()+'.zip'
        bucket=f'{a.stack}-{account}-{a.region}-artifacts'
        # An existing inaccessible bucket is an error, never a reason to reuse someone else's bucket.
        buckets=obj('s3api','list-buckets')['Buckets']
        if not any(b['Name']==bucket for b in buckets):
            args=['s3api','create-bucket','--bucket',bucket]
            if a.region!='us-east-1': args+=['--create-bucket-configuration',f'LocationConstraint={a.region}']
            aws(*args)
        aws('s3api','put-public-access-block','--bucket',bucket,'--public-access-block-configuration','BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true')
        aws('s3','cp',str(zip_path),f's3://{bucket}/{code_key}',capture=False)
        repo=a.stack+'-scorer'
        if not any(r['repositoryName']==repo for r in obj('ecr','describe-repositories')['repositories']):
            aws('ecr','create-repository','--repository-name',repo,'--image-scanning-configuration','scanOnPush=true')
        uri=f'{account}.dkr.ecr.{a.region}.amazonaws.com/{repo}'
        if not (a.reuse_image and state.get('image')):
            context=ROOT/'backend/lambdas/risk-scorer'
            digest=hashlib.sha256(b''.join(f.name.encode()+f.read_bytes() for f in sorted(context.iterdir()) if f.is_file())).hexdigest()[:16]
            tag=uri+':'+digest
            password=aws('ecr','get-login-password')
            run(['docker','login','--username','AWS','--password-stdin',uri.split('/')[0]],input=password,env=env)
            run(['docker','buildx','build','--platform','linux/amd64','--provenance=false','--load','-t',tag,str(context)],env=env)
            run(['docker','push',tag],env=env)
            image_digest=obj('ecr','describe-images','--repository-name',repo,'--image-ids','imageTag='+digest)['imageDetails'][0]['imageDigest']
            state['image']=uri+'@'+image_digest
        state.update(artifact_bucket=bucket,code_key=code_key);save()
    if a.phase=='mail':
        if not all(k in state for k in ['artifact_bucket','code_key','image']): raise RuntimeError('Run deploy first in this same folder/account/region.')
        if not state.get('authmail_built'): raise RuntimeError('Run deploy once with this version of the code first: it uploads the email functions the mail phase switches on.')
        sender=(a.sender or '').strip().lower()
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',sender): p.error('mail needs --sender you@example.org')
        try: identity=obj('sesv2','get-email-identity','--email-identity',sender)
        except RuntimeError as e:
            if 'NotFoundException' not in str(e): raise
            aws('sesv2','create-email-identity','--email-identity',sender)
            identity={'VerifiedForSendingStatus':False}
            print(f'Amazon SES sent a verification email to {sender}. Open it and click the link (check spam).')
        while not identity.get('VerifiedForSendingStatus'):
            input('Press Enter once you have clicked the verification link (Ctrl+C to stop)... ')
            identity=obj('sesv2','get-email-identity','--email-identity',sender)
            if not identity.get('VerifiedForSendingStatus'): print('Not verified yet. The link can take a minute to register.')
        print(f'{sender} is verified for sending.')
        account_info=obj('sesv2','get-account')
        if not account_info.get('ProductionAccessEnabled'):
            print('\nSES IS IN THE SANDBOX for this account and region: it delivers ONLY to verified addresses.')
            print('  For a live test, verify each recipient:  aws sesv2 create-email-identity --email-identity person@example.org')
            print('  For real use, request production access: SES console -> Account dashboard -> Request production access.')
            print('  Until then, emails to unverified people fail and the app shows their temporary password instead.\n')
        state['mail_from']=sender;save()
    if a.phase in ['deploy','google','mail','sms']:
        if not all(k in state for k in ['artifact_bucket','code_key','image']): raise RuntimeError('Run deploy first in this same folder/account/region.')
        template=BUILD/'template.json';template.write_text(json.dumps(make_template(),indent=2))
        params=[{'ParameterKey':k,'ParameterValue':v} for k,v in {'ArtifactBucket':state['artifact_bucket'],'CodeKey':state['code_key'],'ScorerImage':state['image']}.items()]
        if a.phase=='mail': params.append({'ParameterKey':'MailFrom','ParameterValue':state['mail_from']})
        if a.phase=='google':
            o=outputs()
            print('Register BOTH redirect URIs in one Google OAuth Web Application:')
            print(o['SchoolDomain']+'/oauth2/idpresponse');print(o['AngazaDomain']+'/oauth2/idpresponse')
            client_id=input('Google OAuth client ID: ').strip();secret=getpass.getpass('Google OAuth client secret (hidden): ').strip()
            if not client_id.endswith('.apps.googleusercontent.com') or not secret: raise RuntimeError('Missing or invalid Google OAuth credentials.')
            params.extend([{'ParameterKey':'GoogleClientId','ParameterValue':client_id},{'ParameterKey':'GoogleClientSecret','ParameterValue':secret}])
        if a.phase=='sms':
            print("Africa's Talking: use username 'sandbox' and the sandbox app's API key to test with their simulator,")
            print('or your live app username and key to reach real phones (the account needs credit).')
            username=input("Africa's Talking username [sandbox]: ").strip() or 'sandbox'
            key=getpass.getpass("Africa's Talking API key (hidden): ").strip()
            sender='' if username=='sandbox' else input('Approved sender ID (Enter for the shared default): ').strip()
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}',username) or not key: raise RuntimeError("Missing or invalid Africa's Talking username or API key.")
            params.extend([{'ParameterKey':'AtUsername','ParameterValue':username},{'ParameterKey':'AtApiKey','ParameterValue':key},
                {'ParameterKey':'AtSenderId','ParameterValue':sender}])
        # cloudformation deploy automatically preserves existing values for omitted parameters.
        # The secret is a NoEcho CFN parameter in a temporary file, never a process argument or saved config.
        fd,temp=tempfile.mkstemp(suffix='.json')
        try:
            with os.fdopen(fd,'w') as f: json.dump(params,f)
            aws('cloudformation','deploy','--template-file',str(template),'--stack-name',a.stack,'--s3-bucket',state['artifact_bucket'],
                '--capabilities','CAPABILITY_IAM','--parameter-overrides','file://'+temp,'--no-fail-on-empty-changeset',capture=False)
        finally: Path(temp).unlink(missing_ok=True)
        if a.phase=='google': state['google_enabled']=True;save()
        if a.phase=='sms': state['sms_username']=username;save()
        if a.phase=='deploy': state['authmail_built']=True;save()
        o=outputs();appenv(o)
        if a.phase=='deploy':
            run(['node','local/publish-model.js',a.model],env=appenv(o))
        web(o)
        print('\nSchool portal: '+o['SiteUrl']+'/sign-in\nAngaza portal: '+o['SiteUrl']+'/angaza')
        if not state.get('google_enabled'): print('Google is not enabled yet. Complete Google Console setup, then run the google phase.')
        if not state.get('mail_from'): print('Email uses the Cognito default sender and the app does not email sign-in details yet. Run the mail phase (see deploy/aws/README.md).')
        return
    o=outputs()
    if a.phase=='outputs':
        print(json.dumps(o,indent=2));return
    if a.phase=='web': web(o)
    if a.phase=='model': run(['node','local/publish-model.js',a.model],env=appenv(o))
    if a.phase=='staff':
        if not all([a.email,a.first,a.last]): p.error('staff needs --email, --first and --last')
        run(['node','local/add-angaza-staff.js','--email',a.email,'--first',a.first,'--last',a.last],env=appenv(o))
if __name__=='__main__':
    try: main()
    except (RuntimeError,KeyboardInterrupt) as e:
        print('\nSTOPPED: '+str(e),file=sys.stderr)
        print('For CloudFormation failures, open the stack Events tab and read the FIRST CREATE_FAILED/UPDATE_FAILED reason. Fix that cause before retrying.',file=sys.stderr)
        sys.exit(1)
