import pathlib
import runpy
import sys
import types
import unittest
from unittest.mock import Mock, patch


class CodeOnlyReleaseTests(unittest.TestCase):
    def test_code_only_never_opens_sftp_or_requires_application_secrets(self):
        loader = types.ModuleType('_deploy_env')
        loader.require = Mock(return_value={
            'HOSTINGER_HOST': 'test-host', 'HOSTINGER_USER': 'test-user',
            'HOSTINGER_SSH_KEY_PATH': 'test-key-path',
        })
        ssh = Mock()
        paramiko = types.ModuleType('paramiko')
        paramiko.SSHClient = Mock(return_value=ssh)
        paramiko.AutoAddPolicy = Mock()
        script = pathlib.Path(__file__).resolve().parents[1] / 'deploy_hostinger_server.py'
        with patch.dict(sys.modules, {'_deploy_env': loader, 'paramiko': paramiko}), \
                patch.object(sys, 'argv', [str(script), '--code-only']):
            namespace = runpy.run_path(str(script))
        loader.require.assert_called_once_with(
            'HOSTINGER_HOST', 'HOSTINGER_USER', 'HOSTINGER_SSH_KEY_PATH')
        self.assertIsNone(namespace['ENV_CONTENT'])
        commands = []

        def run(connection, command, check=True):
            commands.append(command)
            return 'test-sha' if 'git rev-parse HEAD' in command else ''

        namespace['main'].__globals__.update(run=run, safe_print=lambda value: None)
        with patch('subprocess.run', return_value=types.SimpleNamespace(stdout='test-sha')):
            namespace['main']()
        ssh.open_sftp.assert_not_called()
        self.assertEqual(commands[0], 'test -s /root/nerxux/server/.env')
        self.assertFalse(any('viewe-dashboard' in command for command in commands))


if __name__ == '__main__':
    unittest.main()
