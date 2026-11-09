"""Generate plain CloudFormation from this checkout's real schema/resolver map."""
import json, re
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
def ref(x): return {'Ref': x}
def sub(x): return {'Fn::Sub': x}
def att(x,y): return {'Fn::GetAtt':[x,y]}
def iff(c,a,b): return {'Fn::If':[c,a,b]}
def make_template():
    R={}
    def add(n,t,p,**kw): R[n]={'Type':t,'Properties':p,**kw}
    retain={'DeletionPolicy':'Retain','UpdateReplacePolicy':'Retain'}
    block={k:True for k in ['BlockPublicAcls','BlockPublicPolicy','IgnorePublicAcls','RestrictPublicBuckets']}
    for n in ['WebBucket','ReportBucket','ModelBucket']:
        add(n,'AWS::S3::Bucket',{'PublicAccessBlockConfiguration':block,'BucketEncryption':{'ServerSideEncryptionConfiguration':[{'ServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]}},**retain)
    for n in ['ReportBucket','ModelBucket']:
        R[n]['Properties']['VersioningConfiguration']={'Status':'Enabled'}
    add('OAC','AWS::CloudFront::OriginAccessControl',{'OriginAccessControlConfig':{'Name':sub('${AWS::StackName}-web'),'OriginAccessControlOriginType':'s3','SigningBehavior':'always','SigningProtocol':'sigv4'}})
    add('Web','AWS::CloudFront::Distribution',{'DistributionConfig':{'Enabled':True,'DefaultRootObject':'index.html','PriceClass':'PriceClass_100','HttpVersion':'http2','IPV6Enabled':True,
        'Origins':[{'Id':'web','DomainName':att('WebBucket','RegionalDomainName'),'OriginAccessControlId':ref('OAC'),'S3OriginConfig':{'OriginAccessIdentity':''}}],
        'DefaultCacheBehavior':{'TargetOriginId':'web','ViewerProtocolPolicy':'redirect-to-https','AllowedMethods':['GET','HEAD','OPTIONS'],'CachedMethods':['GET','HEAD'],'Compress':True,
            'CachePolicyId':'658327ea-f89d-4fab-a63d-7e88639e58f6'},
        'CustomErrorResponses':[{'ErrorCode':code,'ResponseCode':200,'ResponsePagePath':'/index.html','ErrorCachingMinTTL':0} for code in [403,404]],
        'ViewerCertificate':{'CloudFrontDefaultCertificate':True}}})
    add('WebBucketPolicy','AWS::S3::BucketPolicy',{'Bucket':ref('WebBucket'),'PolicyDocument':{'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':'cloudfront.amazonaws.com'},'Action':'s3:GetObject','Resource':sub('${WebBucket.Arn}/*'),'Condition':{'StringEquals':{'AWS:SourceArn':sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Web}')}}}]}})
    keys=['PK','SK','GSI1PK','GSI1SK','GSI2PK','GSI2SK','GSI3PK','GSI3SK']
    def key_schema(pk,sk): return [{'AttributeName':pk,'KeyType':'HASH'},{'AttributeName':sk,'KeyType':'RANGE'}]
    add('Table','AWS::DynamoDB::Table',{'BillingMode':ref('DynamoBillingMode'),'ProvisionedThroughput':iff('Provisioned',{'ReadCapacityUnits':5,'WriteCapacityUnits':5},ref('AWS::NoValue')),'AttributeDefinitions':[{'AttributeName':k,'AttributeType':'S'} for k in keys],
        'KeySchema':key_schema('PK','SK'),'GlobalSecondaryIndexes':[{'IndexName':f'GSI{i}','ProvisionedThroughput':iff('Provisioned',{'ReadCapacityUnits':5,'WriteCapacityUnits':5},ref('AWS::NoValue')),'KeySchema':key_schema(f'GSI{i}PK',f'GSI{i}SK'),'Projection':{'ProjectionType':'ALL'}} for i in [1,2,3]]},**retain)
    add('Bus','AWS::Events::EventBus',{'Name':sub('${AWS::StackName}-events')})
    def trust(service): return {'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':service},'Action':'sts:AssumeRole'}]}
    def policy(actions,resources): return {'Effect':'Allow','Action':actions,'Resource':resources}
    logs=policy(['logs:CreateLogStream','logs:PutLogEvents'],sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${AWS::StackName}-*:*'))
    add('LinkRole','AWS::IAM::Role',{'AssumeRolePolicyDocument':trust('lambda.amazonaws.com'),'Policies':[{'PolicyName':'link-invited-users','PolicyDocument':{'Version':'2012-10-17','Statement':[logs,policy(['cognito-idp:ListUsers','cognito-idp:AdminListGroupsForUser','cognito-idp:AdminLinkProviderForUser'],sub('arn:${AWS::Partition}:cognito-idp:${AWS::Region}:${AWS::AccountId}:userpool/*'))]}}]})
    add('LinkFunction','AWS::Lambda::Function',{'FunctionName':sub('${AWS::StackName}-google-link'),'Runtime':'nodejs22.x','Handler':'link.handler','Role':att('LinkRole','Arn'),
        'Code':{'S3Bucket':ref('ArtifactBucket'),'S3Key':ref('CodeKey')},'Timeout':5,'MemorySize':256})
    for realm in ['School','Angaza']:
        schema=[{'Name':'google_hd','AttributeDataType':'String','Mutable':True}]
        if realm=='School': schema.append({'Name':'school_id','AttributeDataType':'String','Mutable':True})
        add(realm+'Pool','AWS::Cognito::UserPool',{'UserPoolName':sub('${AWS::StackName}-'+realm.lower()),'UserPoolTier':'LITE',
            'UsernameAttributes':['email'],'UsernameConfiguration':{'CaseSensitive':False},'AutoVerifiedAttributes':['email'],
            'AdminCreateUserConfig':{'AllowAdminCreateUserOnly':True},'AccountRecoverySetting':{'RecoveryMechanisms':[{'Name':'verified_email','Priority':1}]},
            'EmailConfiguration':{'EmailSendingAccount':'COGNITO_DEFAULT'},'Schema':schema,
            'Policies':{'PasswordPolicy':{'MinimumLength':8,'RequireLowercase':True,'RequireUppercase':True,'RequireNumbers':True,'RequireSymbols':True,'TemporaryPasswordValidityDays':7}},
            'LambdaConfig':{'PreSignUp':att('LinkFunction','Arn')}},**retain)
        add(realm+'LinkPermission','AWS::Lambda::Permission',{'Action':'lambda:InvokeFunction','FunctionName':ref('LinkFunction'),'Principal':'cognito-idp.amazonaws.com','SourceArn':att(realm+'Pool','Arn'),'SourceAccount':ref('AWS::AccountId')})
        add(realm+'Domain','AWS::Cognito::UserPoolDomain',{'UserPoolId':ref(realm+'Pool'),'Domain':sub('${AWS::StackName}-${AWS::AccountId}-'+realm.lower()),'ManagedLoginVersion':1})
        add(realm+'Google','AWS::Cognito::UserPoolIdentityProvider',{'UserPoolId':ref(realm+'Pool'),'ProviderName':'Google','ProviderType':'Google',
            'ProviderDetails':{'client_id':ref('GoogleClientId'),'client_secret':ref('GoogleClientSecret'),'authorize_scopes':'openid email profile'},
            'AttributeMapping':{'email':'email','email_verified':'email_verified','name':'name','custom:google_hd':'hd'}},Condition='UseGoogle')
        path='/auth/callback' if realm=='School' else '/angaza/auth/callback'
        logout='/sign-in' if realm=='School' else '/angaza/sign-in'
        add(realm+'Client','AWS::Cognito::UserPoolClient',{'UserPoolId':ref(realm+'Pool'),'ClientName':'web','GenerateSecret':False,
            'ExplicitAuthFlows':['ALLOW_USER_PASSWORD_AUTH','ALLOW_REFRESH_TOKEN_AUTH'],'PreventUserExistenceErrors':'ENABLED',
            'AllowedOAuthFlowsUserPoolClient':True,'AllowedOAuthFlows':['code'],'AllowedOAuthScopes':['openid','email','profile'],
            'SupportedIdentityProviders':iff('UseGoogle',['COGNITO',ref(realm+'Google')],['COGNITO']),
            'CallbackURLs':[sub('https://${Web.DomainName}'+path)],'LogoutURLs':[sub('https://${Web.DomainName}'+logout)],
            'ReadAttributes':['email','email_verified','name']+(['custom:school_id'] if realm=='School' else []),
            'WriteAttributes':['email','name','custom:google_hd'],
            'EnableTokenRevocation':True,'RefreshTokenValidity':30,'AccessTokenValidity':60,'IdTokenValidity':60,
            'TokenValidityUnits':{'RefreshToken':'days','AccessToken':'minutes','IdToken':'minutes'}})
    for name,pool in [('Admin','School'),('Teacher','School'),('PlatformAdmin','Angaza')]:
        add(name+'Group','AWS::Cognito::UserPoolGroup',{'GroupName':name,'UserPoolId':ref(pool+'Pool')})
    add('FailureQueue','AWS::SQS::Queue',{'MessageRetentionPeriod':1209600,'SqsManagedSseEnabled':True})
    statements=[logs,
        policy(['dynamodb:GetItem','dynamodb:BatchGetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:Query','dynamodb:Scan','dynamodb:BatchWriteItem','dynamodb:ConditionCheckItem'],[att('Table','Arn'),sub('${Table.Arn}/index/*')]),
        policy(['s3:GetObject','s3:PutObject'],[sub('${ReportBucket.Arn}/*'),sub('${ModelBucket.Arn}/*')]),
        policy(['events:PutEvents'],att('Bus','Arn')),
        policy(['states:StartExecution'],sub('arn:${AWS::Partition}:states:${AWS::Region}:${AWS::AccountId}:stateMachine:${AWS::StackName}-reports')),
        policy(['lambda:InvokeFunction'],[sub('arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${AWS::StackName}-prediction'),sub('arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${AWS::StackName}-scorer')]),
        policy(['cognito-idp:AdminCreateUser','cognito-idp:AdminGetUser','cognito-idp:AdminUpdateUserAttributes','cognito-idp:AdminAddUserToGroup','cognito-idp:AdminRemoveUserFromGroup','cognito-idp:AdminListGroupsForUser','cognito-idp:AdminDisableUser','cognito-idp:AdminEnableUser','cognito-idp:AdminSetUserPassword','cognito-idp:AdminResetUserPassword'],att('SchoolPool','Arn')),
        policy(['sqs:SendMessage'],att('FailureQueue','Arn'))]
    add('BackendRole','AWS::IAM::Role',{'AssumeRolePolicyDocument':trust('lambda.amazonaws.com'),'Policies':[{'PolicyName':'application-resources','PolicyDocument':{'Version':'2012-10-17','Statement':statements}}]})
    env={'GRADEBOOK_TABLE_NAME':ref('Table'),'REPORT_BUCKET':ref('ReportBucket'),'MODEL_BUCKET':ref('ModelBucket'),'EVENT_BUS_NAME':ref('Bus'),
        'COGNITO_USER_POOL_ID':ref('SchoolPool'),'PLATFORM_COGNITO_USER_POOL_ID':ref('AngazaPool'),
        'RISK_PREDICTION_FUNCTION':sub('${AWS::StackName}-prediction'),'RISK_SCORER_FUNCTION':sub('${AWS::StackName}-scorer'),
        'REPORT_STATE_MACHINE_ARN':sub('arn:${AWS::Partition}:states:${AWS::Region}:${AWS::AccountId}:stateMachine:${AWS::StackName}-reports'),
        'SCHOOL_TIME_ZONE':'Africa/Nairobi'}
    for n,handler,timeout,memory in [('Api','api',120,1024),('Prediction','prediction',900,1024),('Report','report',60,512)]:
        add(n+'Function','AWS::Lambda::Function',{'FunctionName':sub('${AWS::StackName}-'+handler),'Runtime':'nodejs22.x','Handler':handler+'.handler','Role':att('BackendRole','Arn'),
            'Code':{'S3Bucket':ref('ArtifactBucket'),'S3Key':ref('CodeKey')},'Timeout':timeout,'MemorySize':memory,'Environment':{'Variables':env}})
    add('ScorerRole','AWS::IAM::Role',{'AssumeRolePolicyDocument':trust('lambda.amazonaws.com'),'Policies':[{'PolicyName':'read-models','PolicyDocument':{'Version':'2012-10-17','Statement':[logs,policy(['s3:GetObject'],sub('${ModelBucket.Arn}/*'))]}}]})
    add('ScorerFunction','AWS::Lambda::Function',{'FunctionName':sub('${AWS::StackName}-scorer'),'PackageType':'Image','Architectures':['x86_64'],
        'Code':{'ImageUri':ref('ScorerImage')},'Role':att('ScorerRole','Arn'),'Timeout':900,'MemorySize':2048,'EphemeralStorage':{'Size':1024},
        'Environment':{'Variables':{'MODEL_BUCKET':ref('ModelBucket'),'MODEL_POINTER_TTL_SECONDS':'60','COUNTERFACTUAL_OPTIONS':'3','COUNTERFACTUAL_SEED':'20261','NUMBA_CACHE_DIR':'/tmp'}}})
    for n,suffix in [('Api','api'),('Prediction','prediction'),('Report','report'),('Scorer','scorer'),('Link','google-link')]:
        add(n+'Logs','AWS::Logs::LogGroup',{'LogGroupName':sub('/aws/lambda/${AWS::StackName}-'+suffix),'RetentionInDays':7})
        R[n+'Function']['DependsOn']=[n+'Logs']
    add('PredictionAsync','AWS::Lambda::EventInvokeConfig',{'FunctionName':ref('PredictionFunction'),'Qualifier':'$LATEST','MaximumRetryAttempts':2,'DestinationConfig':{'OnFailure':{'Destination':att('FailureQueue','Arn')}}})
    add('RiskRule','AWS::Events::Rule',{'EventBusName':ref('Bus'),'EventPattern':json.loads((ROOT/'infra/event-rules.json').read_text())['rules'][0]['event_pattern'],
        'Targets':[{'Id':'prediction','Arn':att('PredictionFunction','Arn')}]})
    add('RiskPermission','AWS::Lambda::Permission',{'Action':'lambda:InvokeFunction','FunctionName':ref('PredictionFunction'),'Principal':'events.amazonaws.com','SourceArn':att('RiskRule','Arn')})
    add('StateRole','AWS::IAM::Role',{'AssumeRolePolicyDocument':trust('states.amazonaws.com'),'Policies':[{'PolicyName':'report-worker','PolicyDocument':{'Version':'2012-10-17','Statement':[policy(['lambda:InvokeFunction'],att('ReportFunction','Arn'))]}}]})
    add('ReportMachine','AWS::StepFunctions::StateMachine',{'StateMachineName':sub('${AWS::StackName}-reports'),'StateMachineType':'STANDARD','RoleArn':att('StateRole','Arn'),
        'DefinitionString':(ROOT/'infra/report-card-state-machine.asl.json').read_text(),'DefinitionSubstitutions':{'ReportCardWorkerArn':att('ReportFunction','Arn')}})
    add('Api','AWS::AppSync::GraphQLApi',{'Name':sub('${AWS::StackName}-graphql'),'AuthenticationType':'AMAZON_COGNITO_USER_POOLS',
        'UserPoolConfig':{'UserPoolId':ref('SchoolPool'),'AwsRegion':ref('AWS::Region'),'DefaultAction':'ALLOW','AppIdClientRegex':ref('SchoolClient')},
        'AdditionalAuthenticationProviders':[{'AuthenticationType':'AMAZON_COGNITO_USER_POOLS','UserPoolConfig':{'UserPoolId':ref('AngazaPool'),'AwsRegion':ref('AWS::Region'),'AppIdClientRegex':ref('AngazaClient')}}]})
    schema=(ROOT/'graphql/schema/gradebook.graphql').read_text()
    schema=re.sub(r'^scalar AWS\w+\s*$', '', schema, flags=re.M)
    schema=re.sub(r'\btype (\w+)\s*\{',r'type \1 @aws_cognito_user_pools {',schema)
    add('Schema','AWS::AppSync::GraphQLSchema',{'ApiId':att('Api','ApiId'),'Definition':schema})
    add('AppSyncRole','AWS::IAM::Role',{'AssumeRolePolicyDocument':trust('appsync.amazonaws.com'),'Policies':[{'PolicyName':'invoke-api','PolicyDocument':{'Version':'2012-10-17','Statement':[policy(['lambda:InvokeFunction'],att('ApiFunction','Arn'))]}}]})
    add('DataSource','AWS::AppSync::DataSource',{'ApiId':att('Api','ApiId'),'Name':'backend','Type':'AWS_LAMBDA','ServiceRoleArn':att('AppSyncRole','Arn'),'LambdaConfig':{'LambdaFunctionArn':att('ApiFunction','Arn')}})
    text=(ROOT/'local/resolvers.js').read_text()
    for parent in ['Query','Mutation']:
        body=re.search(r'  '+parent+r': \{(.*?)\n  \}',text,re.S).group(1)
        for field in re.findall(r'^    (\w+):',body,re.M):
            add(parent+field[0].upper()+field[1:],'AWS::AppSync::Resolver',{'ApiId':att('Api','ApiId'),'TypeName':parent,'FieldName':field,'DataSourceName':att('DataSource','Name'),
                'RequestMappingTemplate':'{"version":"2018-05-29","operation":"Invoke","payload":$util.toJson($context)}',
                'ResponseMappingTemplate':'#if($ctx.error)\n$util.error($ctx.error.message,$ctx.error.type)\n#end\n#if($ctx.result.error)\n$util.error($ctx.result.error.message,$ctx.result.error.type)\n#end\n$util.toJson($ctx.result.data)'},DependsOn=['Schema'])
    outputs={k:{'Value':v} for k,v in {'SiteUrl':sub('https://${Web.DomainName}'),'DistributionId':ref('Web'),'WebBucket':ref('WebBucket'),'ReportBucket':ref('ReportBucket'),'ModelBucket':ref('ModelBucket'),
        'TableName':ref('Table'),'GraphqlUrl':att('Api','GraphQLUrl'),'SchoolPoolId':ref('SchoolPool'),'SchoolClientId':ref('SchoolClient'),'AngazaPoolId':ref('AngazaPool'),'AngazaClientId':ref('AngazaClient'),
        'SchoolDomain':sub('https://${SchoolDomain}.auth.${AWS::Region}.amazoncognito.com'),'AngazaDomain':sub('https://${AngazaDomain}.auth.${AWS::Region}.amazoncognito.com'),
        'ScorerFunction':ref('ScorerFunction'),'PredictionFunction':ref('PredictionFunction'),'FailureQueueUrl':ref('FailureQueue')}.items()}
    return {'AWSTemplateFormatVersion':'2010-09-09','Description':'ConnectED isolated demo deployment: AppSync, two Cognito pools, serverless workflows, private S3 + CloudFront.',
        'Parameters':{k:{'Type':'String',**extra} for k,extra in {'ArtifactBucket':{},'CodeKey':{},'ScorerImage':{},'DynamoBillingMode':{'Default':'PROVISIONED','AllowedValues':['PROVISIONED','PAY_PER_REQUEST']},'GoogleClientId':{'Default':''},'GoogleClientSecret':{'Default':'','NoEcho':True}}.items()},
        'Conditions':{'Provisioned':{'Fn::Equals':[ref('DynamoBillingMode'),'PROVISIONED']},'UseGoogle':{'Fn::Not':[{'Fn::Equals':[ref('GoogleClientId'),'']}]}},'Resources':R,'Outputs':outputs}
if __name__=='__main__':
    out=ROOT/'deploy/aws/.build/template.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(make_template(),indent=2));print(out)
