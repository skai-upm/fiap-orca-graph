from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, status

from .database import UserModel, user_from_token


SESSION_COOKIE = "orca_session"


async def current_user(
    orca_session: Annotated[str | None, Cookie()] = None,
) -> UserModel:
    user = await user_from_token(orca_session)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    return user


CurrentUser = Annotated[UserModel, Depends(current_user)]
