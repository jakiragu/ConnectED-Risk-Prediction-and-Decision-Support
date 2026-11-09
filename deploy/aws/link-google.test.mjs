import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandler } from './link-google.js';
const event = () => ({ triggerSource: 'PreSignUp_ExternalProvider', userPoolId: 'eu-west-1_school', userName: 'Google_12345', request: { userAttributes: { email: 'teacher@gmail.com', email_verified: 'true' } } });
const user = () => ({ Username: 'original-user-id', Enabled: true, UserStatus: 'CONFIRMED', Attributes: [
  { Name: 'email_verified', Value: 'true' }, { Name: 'custom:school_id', Value: 'school-1' },
] });
function mock(users = [user()], groups = ['Teacher']) {
  const calls=[];
  const handler=makeHandler(async command => {
    calls.push(command);
    if(command.constructor.name === 'ListUsersCommand') return { Users: users };
    if(command.constructor.name === 'AdminListGroupsForUserCommand') return { Groups: groups.map(GroupName => ({ GroupName })) };
    return {};
  });
  return {handler,calls};
}
test('links verified Google identity to original native subject without creating users or roles', async () => {
  const {handler,calls}=mock(); await handler(event());
  assert.deepEqual(calls.at(-1).input.DestinationUser,{ProviderName:'Cognito',ProviderAttributeValue:'original-user-id'});
  assert.equal(calls.at(-1).input.SourceUser.ProviderAttributeValue,'12345');
  assert.equal(calls.length,3);
});
test('unverified Google email is refused before lookup',async()=>{const {handler,calls}=mock();const e=event();e.request.userAttributes.email_verified='false';await assert.rejects(handler(e));assert.equal(calls.length,0);});
test('uninvited account is refused',async()=>{await assert.rejects(mock([]).handler(event()));});
test('disabled native account is refused',async()=>{const u=user();u.Enabled=false;await assert.rejects(mock([u]).handler(event()));});
test('temporary password must be changed first',async()=>{const u=user();u.UserStatus='FORCE_CHANGE_PASSWORD';await assert.rejects(mock([u]).handler(event()));});
test('school role required',async()=>{await assert.rejects(mock([user()],[]).handler(event()));});
test('Angaza linking requires PlatformAdmin',async()=>{const u=user();u.Attributes=u.Attributes.filter(a=>a.Name!=='custom:school_id');await assert.rejects(mock([u],['Teacher']).handler(event()));await mock([u],['PlatformAdmin']).handler(event());});
test('non-authoritative consumer Google email refused',async()=>{const e=event();e.request.userAttributes.email='teacher@example.com';await assert.rejects(mock().handler(e));});
test('Workspace requires matching signed hosted domain',async()=>{const e=event();e.request.userAttributes.email='teacher@example.com';e.request.userAttributes['custom:google_hd']='example.com';await mock().handler(e);});
test('administrative invitations pass through',async()=>{const e=event();e.triggerSource='PreSignUp_AdminCreateUser';const {handler,calls}=mock();assert.equal(await handler(e),e);assert.equal(calls.length,0);});
